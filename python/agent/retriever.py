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
    """ima 开放接口 POST。"""
    c = ima_creds(creds)
    req = urllib.request.Request(
        'https://%s%s%s' % (IMA_HOST, IMA_BASE, path),
        data=json.dumps(body or {}, ensure_ascii=False).encode('utf-8'),
        headers={'content-type': 'application/json',
                 'ima-openapi-clientid': c['clientId'],
                 'ima-openapi-apikey': c['apiKey']},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _http_get_text(url):
    with urllib.request.urlopen(url, timeout=30) as resp:
        return resp.read().decode('utf-8', 'replace')


def ima_retrieve(query, subject, creds=None):
    """② ima 知识库内检索；未配置或没有可用知识库时返回 None。"""
    c = ima_creds(creds)
    creds = creds or {}
    kb_map = parse_kb_map(creds.get('imaKbMap') or os.environ.get('IMA_KB_MAP') or '')
    kb = (kb_map.get(subject) or (list(kb_map.values())[0] if kb_map else '')
          or creds.get('imaKb') or os.environ.get('IMA_KB') or '')
    if not c['apiKey'] or not c['clientId'] or not kb:
        return None

    sj = _ima_post('/search_knowledge',
                   {'knowledge_base_id': kb, 'query': str(query or ''), 'limit': 6}, creds)
    if sj.get('code') != 0:
        return {'ok': False, 'apiOk': False, 'source': 'ima', 'items': [],
                'error': sj.get('msg')}
    hits = ((sj.get('data') or {}).get('info_list')) or []
    items = []
    for h in hits[:2]:
        entry = {'title': h.get('title'), 'source': 'ima', 'content': ''}
        try:
            mj = _ima_post('/get_media_info', {'media_id': h.get('media_id')}, creds)
            url = (((mj.get('data') or {}).get('url_info') or {}).get('url'))
            if url:
                entry['content'] = _http_get_text(url)[:MAX_CHARS]
        except Exception as e:
            entry['error'] = str(e)
        items.append(entry)
    return {'ok': len(items) > 0, 'apiOk': True, 'source': 'ima',
            'count': len(hits), 'items': items}


def retrieve(query, subject=None, creds=None, uploads=None):
    """统一检索入口（按优先级回落）。"""
    # ① 用户上传的教材优先
    if uploads:
        r = session_corpus_retrieve(query, subject, uploads)
        if r['ok']:
            return r
    # ② ima 知识库
    try:
        via_ima = ima_retrieve(query, subject, creds)
        if via_ima is not None and via_ima.get('ok') is not False:
            return via_ima
        if via_ima is not None and via_ima.get('ok') is False and via_ima.get('apiOk') is False:
            return via_ima  # 接口报错，如实返回
    except Exception:
        pass  # 回落
    # ③ 内置语料
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
    try:
        # 主接口：我可添加的知识库列表（limit <= 50）
        # 兜底：知识库搜索（注意 limit 必须在 (0,20]，否则返回 code 51）
        j = _ima_post('/get_addable_knowledge_base_list', {'limit': 50}, creds)
        if j.get('code') != 0:
            j = _ima_post('/search_knowledge_base', {'limit': 20}, creds)
        if j.get('code') != 0:
            return {'ok': False, 'error': j.get('msg') or ('ima 返回 code %s' % j.get('code'))}

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
    """直接用给定凭证测一次 ima 检索（给 UI 的「测试连接」按钮用；不回落到本地语料）。

    判定标准：接口能正常应答即算连通（命中 0 条只是该测试词没匹配到，不算失败）。
    """
    if not ima_enabled(creds):
        return {'ok': False, 'error': '未填写 ima API Key 或 Client ID'}
    try:
        r = ima_retrieve('纳什均衡', None, creds)
        if not r:
            return {'ok': False, 'error': '未指定知识库：请先「拉取知识库列表」并给学科选择知识库'}
        if r.get('apiOk') is False:
            return {'ok': False, 'error': r.get('error') or 'ima 接口返回错误'}
        count = r.get('count') or 0
        out = dict(r)
        out.update({
            'ok': True,
            'count': count,
            'note': ('连接正常，命中 %s 条' % count) if count > 0
                    else '连接正常（该测试词暂无命中，可换关键词再试）',
        })
        return out
    except Exception as e:
        return {'ok': False, 'error': str(e)}
