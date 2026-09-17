# -*- coding: utf-8 -*-
"""ima 知识库索引器：把库里的**书**下载下来、抽出正文、缓存在本地，然后真正在里面检索。

为什么必须这么做（实测结论，别推翻）：

  1. `search_knowledge` **只匹配标题，不搜正文** —— `highlight_content` 恒为空。
     查「睡眠」能命中《斯坦福高效睡眠法》（标题里有），但查「复利」「注意力」一律 0 条，
     哪怕书里到处都是。
  2. `get_media_info` 给的是**原始文件**的下载地址。你放的是 PDF/EPUB，
     拿到手就是几十 MB 二进制；当文本读只会得到 `%PDF-1.6 %äüöß...`。
  3. 接口有限流：请求一密就返回 `code=200001 请求频率超限`。
     必须串行 + 退避重试 + 持久缓存，否则每次提问都在重新踩雷。
  4. `media_type=99` 是**文件夹**，里面的文件要带 `folder_id` 递归进去列。

所以这里的做法是：
    列出 → 下载 → 抽正文 → 落盘缓存 → 在本地做真正的全文检索。
第一次用某个知识库会慢（要下书），之后是秒回。
"""

import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request

from .textract import extract_text

IMA_HOST = 'ima.qq.com'
IMA_BASE = '/openapi/wiki/v1'

MAX_SECTIONS = 4          # 一次检索最多返回几段
MAX_CHARS_PER_SECTION = 1600
MAX_DOC_TEXT_CHARS = 400_000     # 单篇正文上限（超长的书截断，够检索用）
MAX_DOC_BYTES = 120 * 1024 * 1024  # 单个文件超过这个就不下了（一本扫描书没意义）
MAX_CACHED_DOCS = 120     # 每个知识库最多缓存多少篇
LIST_TTL_SECONDS = 6 * 3600        # 文档列表多久refresh一次

# ima 的 MediaType：能不能抽出正文，看类型就能判断，**不用先下载**。
# 一个知识库里往往几百个文件，大半是图片和网页快照 —— 先下再判断会白等好几分钟。
TEXT_MEDIA_TYPES = {
    1: 'PDF', 3: 'Word', 4: 'PPT', 5: 'Excel/CSV', 7: 'Markdown',
    13: 'TXT', 14: 'Xmind', 21: 'EPUB',
}
SKIP_MEDIA_TYPES = {
    9: '图片（没有文字层）',
    15: '录音（转文字请在 ima 里做）',
    16: '视频',
}
# 网页/公众号/笔记：存的是需要登录才能看的快照，抽不出正文
WEB_MEDIA_TYPES = {2: '网页', 6: '公众号文章', 11: 'ima 笔记', 12: 'AI 会话'}

# 一次 retrieve 最多花多少时间继续建索引（首次会慢，之后为 0）
DEFAULT_BUILD_BUDGET = float(os.environ.get('IMA_INDEX_BUDGET') or 75)

_LOCK = threading.Lock()          # 全局串行：避免并发把接口打限流


# ══════════════════════════════════════════════════════════════════
#  基础请求（带限流退避）
# ══════════════════════════════════════════════════════════════════

class ImaError(Exception):
    def __init__(self, msg, code=None):
        super().__init__(msg)
        self.code = code


def _post(path, body, api_key, client_id, tries=4, timeout=30):
    """带退避重试的 ima POST。限流（200001）自动等待后重试。"""
    last = None
    for i in range(tries):
        req = urllib.request.Request(
            'https://%s%s%s' % (IMA_HOST, IMA_BASE, path),
            data=json.dumps(body or {}, ensure_ascii=False).encode('utf-8'),
            headers={'content-type': 'application/json',
                     'ima-openapi-clientid': client_id,
                     'ima-openapi-apikey': api_key},
            method='POST')
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                j = json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            last = ImaError('ima 返回 HTTP %s' % e.code, e.code)
            time.sleep(1.5 * (i + 1))
            continue
        except Exception as e:
            last = ImaError('连不上 ima（%s）' % e)
            time.sleep(1.5 * (i + 1))
            continue

        code = j.get('code')
        if code in (0, None) or j.get('retcode') == 0:
            return j
        msg = j.get('msg') or j.get('errmsg') or ('code %s' % code)
        last = ImaError(msg, code)
        if code == 200001 or '频率' in str(msg) or '超限' in str(msg):
            time.sleep(2.0 * (i + 1))      # 限流：明显退避
            continue
        if code in (110010, 110021):       # 下游网络 / 频控
            time.sleep(2.0 * (i + 1))
            continue
        break
    raise last or ImaError('ima 请求失败')


def _download(url, max_bytes=MAX_DOC_BYTES, timeout=180):
    req = urllib.request.Request(url, headers={'user-agent': 'academic-galgame/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        length = resp.headers.get('content-length')
        if length and int(length) > max_bytes:
            raise ImaError('文件 %d MB 超过上限，跳过' % (int(length) // 1048576))
        chunks, total = [], 0
        while True:
            b = resp.read(262144)
            if not b:
                break
            total += len(b)
            if total > max_bytes:
                raise ImaError('文件超过 %d MB，跳过' % (max_bytes // 1048576))
            chunks.append(b)
        return b''.join(chunks)


# ══════════════════════════════════════════════════════════════════
#  缓存
# ══════════════════════════════════════════════════════════════════

def cache_root():
    env = os.environ.get('GALGAME_IMA_CACHE')
    if env:
        return os.path.abspath(env)
    base = os.environ.get('GALGAME_HOME')
    if base:
        return os.path.join(os.path.abspath(base), 'ima-cache')
    # 默认放在项目目录旁边（和 .env 同级），方便用户自己看和删
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(here, '.ima-cache')


def _kb_key(kb_id):
    return hashlib.sha1(kb_id.encode('utf-8')).hexdigest()[:16]


def _meta_path(kb_id):
    return os.path.join(cache_root(), _kb_key(kb_id), 'meta.json')


def load_meta(kb_id):
    try:
        with open(_meta_path(kb_id), 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'kb_id': kb_id, 'fetched_at': 0, 'docs': []}


def save_meta(kb_id, meta):
    p = _meta_path(kb_id)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    os.replace(tmp, p)


def _doc_text_path(kb_id, media_id):
    h = hashlib.sha1(media_id.encode('utf-8')).hexdigest()[:20]
    return os.path.join(cache_root(), _kb_key(kb_id), h + '.txt')


def read_doc_text(kb_id, doc):
    if doc.get('file'):
        try:
            with open(doc['file'], 'r', encoding='utf-8', errors='replace') as f:
                return f.read()
        except OSError:
            return ''
    return ''


# ══════════════════════════════════════════════════════════════════
#  枚举（含文件夹递归）
# ══════════════════════════════════════════════════════════════════

def list_documents(kb_id, api_key, client_id, max_docs=300):
    """列出知识库里的所有文件（递归进子文件夹）。"""
    out = []
    seen_folders = set()

    def walk(folder_id, depth):
        if depth > 3 or len(out) >= max_docs:
            return
        if folder_id and folder_id in seen_folders:
            return
        if folder_id:
            seen_folders.add(folder_id)
        cursor = ''
        guard = 0
        while True:
            body = {'knowledge_base_id': kb_id, 'cursor': cursor, 'limit': 50}
            if folder_id:
                body['folder_id'] = folder_id
            j = _post('/get_knowledge_list', body, api_key, client_id)
            data = j.get('data') or {}
            items = data.get('knowledge_list') or data.get('list') or []
            for it in items:
                mid = it.get('media_id') or ''
                is_folder = (str(mid).startswith('folder_') or it.get('media_type') == 99
                             or not mid)
                if is_folder:
                    fid = it.get('folder_id') or mid
                    if fid:
                        walk(fid, depth + 1)
                else:
                    out.append({'media_id': mid, 'title': it.get('title') or '(无标题)',
                                'media_type': it.get('media_type')})
                    if len(out) >= max_docs:
                        return
            cursor = data.get('next_cursor') or ''
            if not cursor or data.get('is_end'):
                break
            guard += 1
            if guard > 20:
                break
            time.sleep(0.3)          # 放慢，别把接口打限流

    walk('', 0)
    return out


# ══════════════════════════════════════════════════════════════════
#  建索引
# ══════════════════════════════════════════════════════════════════

def _title_tokens(s):
    return set(re.findall(r'[\u4e00-\u9fa5]{2,}|[a-z0-9]{2,}', str(s or '').lower()))


def build_index(kb_id, api_key, client_id, budget_seconds=DEFAULT_BUILD_BUDGET,
                focus='', force_relists=False, reset=False):
    """把知识库里还没索引的文档补上。返回本次的统计。

    有预算上限：一次调用最多花 budget_seconds 秒，剩下的下次继续
    （都在本地缓存里，不会白干）。
    reset=True 会把已有的解析结论清掉重来（换了抽取逻辑或想重新扫一遍时用）。
    """
    t_end = time.time() + max(0.0, budget_seconds)
    stats = {'listed': 0, 'indexed': 0, 'skipped': 0, 'failed': 0, 'notes': []}

    with _LOCK:
        meta = load_meta(kb_id)
        if reset:
            meta['fetched_at'] = 0
            for d in meta.get('docs') or []:
                d.pop('status', None)
                d.pop('note', None)
        stale = (time.time() - (meta.get('fetched_at') or 0)) > LIST_TTL_SECONDS
        if stale or force_relists or not meta.get('docs'):
            docs = list_documents(kb_id, api_key, client_id)
            if not docs and meta.get('docs'):
                docs = meta['docs']          # 列失败就沿用旧的
            else:
                meta['docs'] = docs
                meta['fetched_at'] = time.time()
            stats['listed'] = len(docs)
        docs = meta.get('docs') or []

        # 先索引「标题跟关注点沾边」的，再索引其余 —— 让人第一次提问就有收获
        focus_tokens = _title_tokens(focus)

        def pending():
            return [d for d in docs if d.get('status') not in ('ok', 'unsupported', 'toobig')]

        p = pending()
        if focus_tokens:
            p.sort(key=lambda d: -len(focus_tokens & _title_tokens(d.get('title'))))

        # 先按类型把「注定读不了」的挑出来标记掉 —— 不下载、不浪费时间
        todo = []
        for d in p:
            mt = d.get('media_type')
            if mt in SKIP_MEDIA_TYPES:
                d['status'] = 'unsupported'
                d['note'] = SKIP_MEDIA_TYPES[mt]
                stats['skipped'] += 1
                continue
            if mt in WEB_MEDIA_TYPES:
                d['status'] = 'unsupported'
                d['note'] = '%s：正文要登录 ima 才看得到，抽不出来' % WEB_MEDIA_TYPES[mt]
                stats['skipped'] += 1
                continue
            todo.append(d)

        # 未知类型排在能识别的类型后面（多半是些没用的快照）
        todo.sort(key=lambda d: 0 if d.get('media_type') in TEXT_MEDIA_TYPES else 1)

        for doc in todo:
            if time.time() > t_end:
                break
            if stats['indexed'] >= MAX_CACHED_DOCS:
                break
            try:
                m = _post('/get_media_info', {'media_id': doc['media_id']}, api_key, client_id)
            except ImaError as e:
                doc['status'] = 'unsupported'
                doc['note'] = str(e)
                stats['skipped'] += 1
                continue
            url = (((m.get('data') or {}).get('url_info') or {}).get('url'))
            if not url:
                doc['status'] = 'unsupported'
                doc['note'] = m.get('msg') or '拿不到下载地址'
                stats['skipped'] += 1
                continue
            try:
                raw = _download(url)
            except ImaError as e:
                doc['status'] = 'toobig' if '超过' in str(e) else 'failed'
                doc['note'] = str(e)
                stats['failed'] += 1
                continue
            except Exception as e:
                doc['status'] = 'failed'
                doc['note'] = '下载失败：%s' % e
                stats['failed'] += 1
                continue

            text, kind, note = extract_text(raw, doc.get('title') or '')
            if not text:
                doc['status'] = 'unsupported'
                doc['note'] = note or '抽不到正文'
                stats['notes'].append('%s：%s' % (doc.get('title') or '', doc['note']))
                stats['skipped'] += 1
                continue

            text = text[:MAX_DOC_TEXT_CHARS]
            path = _doc_text_path(kb_id, doc['media_id'])
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(text)
            doc.update({'status': 'ok', 'file': path, 'chars': len(text), 'kind': kind, 'note': ''})
            stats['indexed'] += 1
            time.sleep(0.25)        # 别把接口打限流

        save_meta(kb_id, meta)

    stats['total_docs'] = len(docs)
    stats['ready'] = sum(1 for d in docs if d.get('status') == 'ok')
    stats['pending'] = sum(1 for d in docs if d.get('status') not in ('ok', 'unsupported', 'toobig'))
    return stats


# ══════════════════════════════════════════════════════════════════
#  在索引里检索
# ══════════════════════════════════════════════════════════════════

def _tokenize(text):
    """粗分词：英文单词 + 中文单字 + 中文双字组合。"""
    s = str(text or '').lower()
    tokens = set(re.findall(r'[a-z0-9]{2,}', s))
    cjk = re.findall(r'[\u4e00-\u9fa5]', s)
    tokens.update(cjk)
    for i in range(len(cjk) - 1):
        tokens.add(cjk[i] + cjk[i + 1])
    return tokens


# 这些字几乎每段都有，给它们打分等于给所有段落一起加分，反而淹没了真正的关键词
_STOP_CHARS = set('的了是在和有就不我你他她它这那也都与及而或但很太更最一二三四五六七八九十个'
                  '上下来去说想会能要把被为对从到于以之其所')
_STOP_BIGRAMS = {'我们', '他们', '什么', '可以', '这个', '那个', '因为', '所以', '就是',
                 '不是', '没有', '一个', '自己', '时候', '已经', '如果', '这些', '那些'}


def query_terms(text):
    """从查询里提取真正有区分度的检索词。

    关键是**别让「的、是、在」这类字参与打分** —— 否则随便一段都能得高分，
    返回的就不相关了。多字词权重远高于单字。
    """
    s = str(text or '').lower()
    strong = set(re.findall(r'[a-z0-9]{2,}', s))          # 英文词
    cjk = re.findall(r'[\u4e00-\u9fa5]', s)
    for i in range(len(cjk) - 1):
        bg = cjk[i] + cjk[i + 1]
        if bg not in _STOP_BIGRAMS:
            strong.add(bg)
    weak = {c for c in cjk if c not in _STOP_CHARS}
    return strong, weak


def _split_chunks(text, size=900, overlap=150):
    """把长文切成带重叠的块，便于命中后给出完整上下文。"""
    text = text or ''
    if len(text) <= size:
        return [text] if text.strip() else []
    out = []
    step = max(1, size - overlap)
    for i in range(0, len(text), step):
        chunk = text[i:i + size]
        if chunk.strip():
            out.append(chunk)
        if i + size >= len(text):
            break
    return out


def search_index(kb_id, query, subject='', limit=MAX_SECTIONS):
    """在**已索引**的文档里做真正的全文检索。"""
    meta = load_meta(kb_id)
    docs = [d for d in (meta.get('docs') or []) if d.get('status') == 'ok']
    strong, weak = query_terms('%s %s' % (query or '', subject or ''))
    if not docs or (not strong and not weak):
        return {'ok': False, 'items': [], 'indexed': len(docs),
                'total': len(meta.get('docs') or [])}

    scored = []
    for doc in docs:
        text = read_doc_text(kb_id, doc)
        if not text:
            continue
        title = doc.get('title') or ''
        t_strong, t_weak = query_terms(title)
        title_bonus = 60 * len(strong & t_strong) + 8 * len(weak & t_weak)

        for idx, chunk in enumerate(_split_chunks(text)):
            hay = chunk.lower()
            hit_strong = {t for t in strong if t in hay}
            if not hit_strong and not any(t in hay for t in weak):
                continue
            hit_weak = {t for t in weak if t in hay}
            # 长词（双字/英文）权重远高于单字；单个单字命中基本没有区分度
            score = 6 * len(hit_strong) + 0.4 * len(hit_weak)
            if len(hit_strong) >= 2:
                score += 4                       # 同时命中多个关键词，可信得多
            if score <= 1.2:                     # 只蹭到一个单字 → 不要
                continue
            scored.append({'score': score + title_bonus, 'title': title, 'pos': idx,
                           'source': 'ima·%s' % title,
                           'content': chunk[:MAX_CHARS_PER_SECTION],
                           'matched': sorted(hit_strong)[:6]})
    scored.sort(key=lambda x: -x['score'])

    # 同一本书最多出一段，保证覆盖多本书
    items, seen = [], set()
    for s in scored:
        if s['title'] in seen:
            continue
        seen.add(s['title'])
        items.append({'title': s['title'], 'source': s['source'],
                      'content': s['content'], 'matched': s['matched']})
        if len(items) >= limit:
            break
    return {'ok': bool(items), 'items': items, 'indexed': len(docs),
            'total': len(meta.get('docs') or []),
            'terms': sorted(strong)[:8]}


def index_status(kb_id):
    """给 UI / 自检用：这个知识库索引到哪一步了。"""
    meta = load_meta(kb_id)
    docs = meta.get('docs') or []
    ok = [d for d in docs if d.get('status') == 'ok']
    bad = [d for d in docs if d.get('status') in ('unsupported', 'toobig', 'failed')]
    return {
        'kb_id': kb_id,
        'listed': len(docs),
        'ready': len(ok),
        'unreadable': len(bad),
        'chars': sum(d.get('chars') or 0 for d in ok),
        'unreadable_detail': [{'title': d.get('title'), 'why': d.get('note')} for d in bad][:10],
        'last_list': meta.get('fetched_at') or 0,
        'cache_dir': os.path.join(cache_root(), _kb_key(kb_id)),
    }
