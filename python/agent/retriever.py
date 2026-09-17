# -*- coding: utf-8 -*-
"""检索适配器：为教学与出题提供**真实依据**。

依据来源按优先级：
  ① 用户自己上传的教材（浏览器选文件 -> 存本会话内存，不落盘）
  ② 用户自己的 ima 知识库（凭证随请求传入）
  ③ 项目内置 corpus/ 目录（开箱即用的示例教材）
"""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

from . import ima_index

MAX_SECTIONS = 3
MAX_CHARS = 1200
IMA_HOST = 'ima.qq.com'
IMA_BASE = '/openapi/wiki/v1'

CORPUS_DIR = os.path.abspath(
    os.environ.get('GALGAME_CORPUS')
    or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'corpus'))


def tokenize(text):
    """把文本切成检索用的 token（英文单词 + 中文单字与双字组合）。"""
    s = str(text or '').lower()
    tokens = set()
    for w in re.findall(r'[a-z0-9]{2,}', s):
        tokens.add(w)
    cjk = re.findall(r'[\u4e00-\u9fa5]', s)
    for ch in cjk:
        tokens.add(ch)
    for i in range(len(cjk) - 1):
        tokens.add(cjk[i] + cjk[i + 1])
    return list(tokens)


def split_sections(text):
    """按 Markdown 标题切成小节。"""
    lines = str(text or '').split('\n')
    sections = []
    current = {'title': '正文', 'body': []}
    for line in lines:
        m = re.match(r'^(#{1,6})\s+(.*)$', line)
        if m:
            if current['body']:
                sections.append(current)
            current = {'title': m.group(2).strip(), 'body': []}
        else:
            current['body'].append(line)
    if current['body']:
        sections.append(current)
    return sections


def collect_files(directory, depth=0, out=None):
    """递归收集语料文件（限 3 层）。"""
    out = out if out is not None else []
    if depth > 3 or not os.path.exists(directory):
        return out
    for name in os.listdir(directory):
        full = os.path.join(directory, name)
        try:
            is_dir = os.path.isdir(full)
        except OSError:
            continue
        if is_dir:
            collect_files(full, depth + 1, out)
        elif os.path.splitext(name)[1].lower() in ('.md', '.txt'):
            out.append(full)
    return out


def search_docs(docs, query, subject, source):
    """在给定文档集合里检索。docs: [{'name':..,'text':..}]"""
    tokens = tokenize('%s %s' % (query or '', subject or ''))
    if not tokens:
        return {'ok': False, 'source': source, 'count': 0, 'items': [], 'error': '查询为空'}
    scored = []
    for doc in docs:
        for sec in split_sections(doc['text']):
            body = '\n'.join(sec['body']).strip()
            if not body:
                continue
            hay = ('%s\n%s' % (sec['title'], body)).lower()
            score = 0
            for t in tokens:
                if t in hay:
                    score += 2 if len(t) >= 2 else 1
            if score > 0:
                scored.append({'score': score, 'title': sec['title'],
                               'source': doc['name'], 'content': body[:MAX_CHARS]})
    scored.sort(key=lambda x: -x['score'])
    items = [{'title': x['title'], 'source': x['source'], 'content': x['content']}
             for x in scored[:MAX_SECTIONS]]
    return {'ok': len(items) > 0, 'source': source, 'count': len(items), 'items': items}


def session_corpus_retrieve(query, subject, uploads=None):
    """① 用户上传的教材（本会话内存）。

    按学科取用：「通用」（未指定学科）的教材对所有学科可用；
    指定了学科的教材**只**对该学科可用。若该学科下无任何可用教材，则如实返回空。
    """
    all_docs = [f for f in (uploads or [])
                if f and isinstance(f.get('text'), str) and f['text'].strip()]
    if not all_docs:
        return {'ok': False, 'source': 'upload', 'count': 0, 'items': [], 'error': '尚未上传教材'}
    pool = all_docs
    if subject:
        pool = [f for f in all_docs if not f.get('subject') or f.get('subject') == subject]
        if not pool:
            return {
                'ok': False, 'source': 'upload', 'count': 0, 'items': [],
                'error': '该学科（%s）没有可用教材：你上传的文件都指定了别的学科，且没有「通用」教材' % subject,
            }
    docs = [{'name': ('%s（%s）' % (f['name'], f['subject'])) if f.get('subject')
             else (f.get('name') or '上传教材'),
             'text': f['text']} for f in pool]
    return search_docs(docs, query, subject, 'upload')


def local_corpus_retrieve(query, subject):
    """③ 项目内置 corpus/ 目录。"""
    files = collect_files(CORPUS_DIR)
    if not files:
        return {'ok': False, 'source': 'corpus', 'count': 0, 'items': [],
                'error': '语料目录为空：%s（可放入 .md/.txt 教材文件）' % CORPUS_DIR}
    docs = []
    for path in files:
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as fh:
                docs.append({'name': path, 'text': fh.read()})
        except OSError:
            continue
    return search_docs(docs, query, subject, 'corpus')


# ══════════ ima 知识库 ══════════

def ima_creds(creds=None):
    """解析 ima 凭证（请求优先，环境变量兜底）。"""
    creds = creds or {}
    return {
        'apiKey': creds.get('imaApiKey') or os.environ.get('IMA_API_KEY') or '',
        'clientId': creds.get('imaClientId') or os.environ.get('IMA_CLIENT_ID') or '',
    }


def parse_kb_map(raw):
    """解析「学科 -> 知识库ID」映射（字符串或对象都支持）。"""
    try:
        return json.loads(raw or '{}') if isinstance(raw, str) else (raw or {})
    except Exception:
        return {}


def _ima_post(path, body, creds=None):
    """ima 开放接口 POST（带限流退避重试）。"""
    c = ima_creds(creds)
    return ima_index._post(path, body, c['apiKey'], c['clientId'])


def ima_retrieve(query, subject, creds=None):
    """② 在 ima 知识库里检索**正文**。

    做法：先用索引器把库里还没下载的书下下来、抽出正文存到本地，
    再在本地做真正的全文检索 —— 因为 ima 自己的 search_knowledge 只匹配标题，
    书里的内容它搜不到，而且它给的是 PDF/EPUB 原始文件，当文本读是乱码。

    未配置 / 没绑定知识库时返回 None（交给上层回落到内置语料）。
    """
    c = ima_creds(creds)
    creds = creds or {}
    kb_map = parse_kb_map(creds.get('imaKbMap') or os.environ.get('IMA_KB_MAP') or '')
    kb = (kb_map.get(subject) or (list(kb_map.values())[0] if kb_map else '')
          or creds.get('imaKb') or os.environ.get('IMA_KB') or '')
    if not c['apiKey'] or not c['clientId'] or not kb:
        return None

    focus = '%s %s' % (query or '', subject or '')
    try:
        stats = ima_index.build_index(kb, c['apiKey'], c['clientId'], focus=focus)
    except ima_index.ImaError as e:
        return {'ok': False, 'apiOk': False, 'source': 'ima', 'items': [],
                'error': 'ima 接口报错：%s' % e}
    except Exception as e:
        return {'ok': False, 'apiOk': False, 'source': 'ima', 'items': [],
                'error': 'ima 索引失败：%s' % e}

    r = ima_index.search_index(kb, query, subject)
    base = {'source': 'ima', 'indexed': r.get('indexed'), 'total': r.get('total'),
            'kbId': kb, 'indexStats': stats}

    if r.get('ok'):
        base.update({'ok': True, 'apiOk': True, 'count': len(r['items']), 'items': r['items'],
                     'via': '本地全文检索（已下载并解析你的书）'})
        return base

    # 没命中 —— 如实说明卡在哪一步，便于用户自己判断
    if r.get('indexed', 0) == 0 and r.get('total', 0) == 0:
        why = '这个知识库里没列出任何文件'
    elif r.get('indexed', 0) == 0:
        why = ('知识库里有 %d 个文件，但一个都没能解析出正文（%s）'
               % (r.get('total', 0), '；'.join(stats.get('notes') or []) or '见索引状态'))
    else:
        why = '已在 %d 本书里全文检索，没有和「%s」相关的内容' % (r.get('indexed'), query or subject or '')
    base.update({'ok': False, 'apiOk': True, 'count': 0, 'items': [], 'error': why,
                 'hint': '知识库状态：已解析 %s 本 / 共 %s 个文件'
                         % (r.get('indexed'), r.get('total'))})
    return base


def retrieve(query, subject=None, creds=None, uploads=None):
    """统一检索入口（按优先级回落）。

    ⚠️ 一个刻意的行为：**配了 ima 时，绝不静默换成项目内置的示例语料**。
    以前会默默回落，于是用户以为老师在讲自己的书，其实讲的是仓库里的两篇示例 ——
    这正是「抓不到我放在知识库里的书」这个感受的来源之一。
    现在回落时会带上 note 说明「这不是你的资料」，让模型如实告诉用户。
    """
    # ① 用户上传的教材优先
    if uploads:
        r = session_corpus_retrieve(query, subject, uploads)
        if r['ok']:
            return r

    # ② ima 知识库（配了才走，且不再无声回落）
    if ima_enabled(creds):
        try:
            via_ima = ima_retrieve(query, subject, creds)
        except Exception as e:
            via_ima = {'ok': False, 'apiOk': False, 'source': 'ima', 'items': [],
                       'error': str(e)}
        if via_ima is not None:
            if via_ima.get('ok'):
                return via_ima
            local = local_corpus_retrieve(query, subject)
            if local.get('ok'):
                local['fallbackFrom'] = 'ima'
                local['note'] = (
                    '⚠️ 以下内容**不是**你的资料，而是项目内置的示例语料。'
                    '你的 ima 知识库没给出结果，原因：%s。'
                    '请如实告诉用户这一点，不要假装引用了他的书。'
                    % (via_ima.get('error') or '该知识库里没有匹配内容'))
                return local
            via_ima['hint'] = (via_ima.get('hint') or '') + '；内置示例语料里也没有相关内容'
            return via_ima

    # ③ 没配 ima：用内置语料
    return local_corpus_retrieve(query, subject)


def ima_enabled(creds=None):
    """该次请求是否会走 ima（供 UI 提示用）。"""
    c = ima_creds(creds)
    return bool(c['apiKey'] and c['clientId'])


def list_knowledge_bases(creds=None):
    """列出该凭证可用的 ima 知识库（名称 -> ID），供设置面板「按名称选择」。"""
    c = ima_creds(creds)
    if not c['apiKey'] or not c['clientId']:
        return {'ok': False, 'error': '未填写 ima API Key 或 Client ID'}
    j = None
    try:
        # 主接口：我可添加的知识库列表（limit <= 50）
        # 兜底：知识库搜索（注意 limit 必须在 (0,20]，否则返回 code 51）
        j = _ima_post('/get_addable_knowledge_base_list', {'limit': 50}, creds)
    except ima_index.ImaError:
        try:
            j = _ima_post('/search_knowledge_base', {'limit': 20, 'cursor': ''}, creds)
        except ima_index.ImaError as e:
            return {'ok': False, 'error': str(e)}
    try:
        d = j.get('data') or {}
        raw = (d.get('addable_knowledge_base_list') or d.get('info_list') or d.get('list')
               or d.get('knowledge_base_list') or d.get('items')
               or (d if isinstance(d, list) else []))
        items = []
        for it in raw:
            kb_id = (it.get('knowledge_base_id') or it.get('kb_id')
                     or it.get('id') or it.get('base_id') or '')
            name = it.get('name') or it.get('title') or it.get('knowledge_base_name') or '(未命名)'
            if kb_id:
                items.append({'id': kb_id, 'name': name})
        out = {'ok': len(items) > 0, 'items': items}
        if not items:
            out['raw'] = json.dumps(j, ensure_ascii=False)[:500]
        return out
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def test_ima(creds=None):
    """测一次 ima：列出知识库 + 真正开始建索引（给 UI 的「测试连接」用）。

    判定标准：能列出知识库就算连通。如果绑了知识库，顺带报告「已解析几本 / 共几个文件」，
    以及哪些文件读不了、为什么 —— 这些信息对排查「抓不到我的书」最关键。
    """
    if not ima_enabled(creds):
        return {'ok': False, 'error': '未填写 ima API Key 或 Client ID'}

    kbs = list_knowledge_bases(creds)
    if not kbs.get('ok'):
        return {'ok': False, 'error': kbs.get('error') or '拉不到知识库列表'}

    out = {'ok': True, 'kbs': len(kbs['items']),
           'names': [k['name'] for k in kbs['items']][:12]}

    c = ima_creds(creds)
    creds = creds or {}
    kb_map = parse_kb_map(creds.get('imaKbMap') or os.environ.get('IMA_KB_MAP') or '')
    kb = list(kb_map.values())[0] if kb_map else ''
    if not kb:
        out['note'] = '连接正常，列出 %d 个知识库。还没给学科绑定知识库 —— 绑定后我才能读里面的书。' % len(kbs['items'])
        return out

    try:
        stats = ima_index.build_index(kb, c['apiKey'], c['clientId'], budget_seconds=25)
    except Exception as e:
        out['note'] = '连接正常，但建索引失败：%s' % e
        return out

    st = ima_index.index_status(kb)
    out.update({
        'index': st,
        'note': '连接正常。知识库共 %d 个文件，已解析 %d 本（%.1f 万字）%s'
                % (st['listed'], st['ready'], st['chars'] / 10000.0,
                   ('，还有 %d 个待解析（下次提问会继续）' % (st['listed'] - st['ready'] - st['unreadable'])
                    if st['listed'] - st['ready'] - st['unreadable'] > 0 else '')),
    })
    if st['unreadable']:
        out['note'] += '；有 %d 个读不了（多为扫描版/图片版/网页笔记），详见 index.unreadable_detail' % st['unreadable']
    return out
