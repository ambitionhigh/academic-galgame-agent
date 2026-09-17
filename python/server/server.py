# -*- coding: utf-8 -*-
"""零依赖 HTTP 服务：伺服 UI 静态资源 + 提供 /api/* 接口。

【BYOK 自带密钥 + 多用户隔离】
  · 每位访客一个会话（cookie `gal_sid`）-> 游戏进度互不干扰，服务端不落盘
  · 模型/知识库凭证由**浏览器**保存（localStorage），每次请求通过 HTTP 头带上：
      x-llm-key / x-llm-model / x-llm-base
      x-ima-key / x-ima-client-id / x-ima-kb-map
    -> 服务端**不存储任何用户凭证**，公开部署时可完全不配 Key
    （为兼容早期版本，同时接受 x-ark-* 请求头与 ARK_* 环境变量作为别名）
  · 若服务端自己配了 LLM_*/IMA_* 环境变量，则作为缺省值兜底（适合自托管给自己用）

启动：python run.py      （默认 http://127.0.0.1:8787）
"""

import json
import os
import posixpath
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from engine.session import GameSession
from engine.storage import MemoryStorage
from agent.gm import GameMaster
from agent.llm import describe_llm, llm_chat, PROVIDER_PRESETS
from agent.retriever import (retrieve, test_ima, ima_enabled, list_knowledge_bases,
                             ima_creds, parse_kb_map)
from agent import ima_index

from .env import load_env, env_path

ENV_FILE = env_path()
ENV_LOADED = load_env()

WEB_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                        os.pardir, 'web'))
PORT = int(os.environ.get('PORT') or 8787)
HOST = os.environ.get('HOST') or '127.0.0.1'
MAX_SESSIONS = int(os.environ.get('MAX_SESSIONS') or 500)
SESSION_TTL_MS = 6 * 60 * 60 * 1000   # 6 小时未活动即回收
MAX_FILE_CHARS = 400000                # 单个教材文件上限（字符）
MAX_CORPUS_CHARS = 2000000             # 每位访客上传教材总量上限（字符）

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
}

# 每位访客的游戏会话（内存）：sid -> {session, gm, corpus, last}
sessions = {}
sessions_lock = threading.Lock()


def parse_cookies(header):
    out = {}
    if not header:
        return out
    for part in str(header).split(';'):
        i = part.find('=')
        if i < 0:
            continue
        out[part[:i].strip()] = urllib.parse.unquote(part[i + 1:].strip())
    return out


def evict_sessions():
    now = int(time.time() * 1000)
    for sid in list(sessions.keys()):
        if now - sessions[sid]['last'] > SESSION_TTL_MS:
            del sessions[sid]
    while len(sessions) > MAX_SESSIONS:
        oldest_sid = min(sessions, key=lambda s: sessions[s]['last'])
        del sessions[oldest_sid]


def creds_from_headers(headers):
    """从请求头提取用户自带凭证（BYOK）。服务端不持久化这些值。"""
    out = {}

    def pick(header, field):
        v = headers.get(header)
        if isinstance(v, str) and v.strip():
            out[field] = v.strip()

    def pick_encoded(header, field):
        v = headers.get(header)
        if not isinstance(v, str) or not v.strip():
            return
        try:
            out[field] = urllib.parse.unquote(v.strip())
        except Exception:
            out[field] = v.strip()

    pick('x-llm-key', 'llmApiKey')
    pick('x-llm-model', 'llmModel')
    pick('x-llm-base', 'llmBaseUrl')
    # 兼容早期版本
    pick('x-ark-key', 'llmApiKey')
    pick('x-ark-model', 'llmModel')
    pick('x-ark-base', 'llmBaseUrl')
    pick('x-ima-key', 'imaApiKey')
    pick('x-ima-client-id', 'imaClientId')
    pick_encoded('x-ima-kb-map', 'imaKbMap')
    return out


def corpus_view(entry):
    """教材列表视图（不含正文，避免响应过大）。"""
    files = [{'id': f['id'], 'name': f['name'], 'subject': f.get('subject') or '',
              'chars': len(f['text'])} for f in entry['corpus']]
    return {'ok': True, 'files': files,
            'totalChars': sum(len(f['text']) for f in entry['corpus'])}


class Handler(BaseHTTPRequestHandler):
    server_version = 'academic-galgame-py'
    protocol_version = 'HTTP/1.1'

    # ── 基础工具 ──
    def log_message(self, fmt, *args):
        pass  # 保持输出干净

    def _send(self, code, body, content_type='application/json; charset=utf-8', extra_headers=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('content-type', content_type)
        self.send_header('content-length', str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def send_json(self, code, data, extra_headers=None):
        self._send(code, json.dumps(data, ensure_ascii=False), extra_headers=extra_headers)

    def read_body(self, limit=1000000):
        length = int(self.headers.get('content-length') or 0)
        if length > limit:
            raise ValueError('请求体过大')
        raw = self.rfile.read(length) if length else b''
        if not raw:
            return {}
        return json.loads(raw.decode('utf-8'))

    def session_for(self):
        """取出（或新建）该访客的会话，必要时下发 cookie。"""
        sid = parse_cookies(self.headers.get('cookie')).get('gal_sid')
        with sessions_lock:
            entry = sessions.get(sid) if sid else None
            set_cookie = None
            if not entry:
                session = GameSession(MemoryStorage())
                entry = {'session': session, 'gm': GameMaster(session),
                         'corpus': [], 'last': int(time.time() * 1000)}
                new_id = str(uuid.uuid4())
                sessions[new_id] = entry
                set_cookie = 'gal_sid=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400' % new_id
                evict_sessions()
            entry['last'] = int(time.time() * 1000)
        return entry, set_cookie

    def serve_static(self, pathname):
        rel = 'index.html' if pathname == '/' else urllib.parse.unquote(pathname).lstrip('/')
        target = os.path.abspath(os.path.join(WEB_ROOT, os.path.normpath(rel)))
        if not target.startswith(WEB_ROOT):
            self._send(403, 'forbidden', 'text/plain; charset=utf-8')
            return
        try:
            with open(target, 'rb') as fh:
                data = fh.read()
            ctype = MIME.get(os.path.splitext(target)[1].lower(), 'application/octet-stream')
            self._send(200, data, ctype)
        except OSError:
            self._send(404, '404 not found', 'text/plain; charset=utf-8')

    # ── 路由 ──
    def dispatch(self):
        parsed = urllib.parse.urlparse(self.path)
        pathname = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        method = self.command
        try:
            if pathname == '/api/health':
                server_llm = describe_llm({})      # 只反映服务端预置（BYOK 时为空）
                creds = creds_from_headers(self.headers)
                client_ok = bool(creds.get('llmApiKey') and creds.get('llmModel'))
                client_llm = describe_llm(creds)
                return self.send_json(200, {
                    'ok': True,
                    'byok': True,
                    'llmConfigured': client_ok or server_llm['configured'],
                    'model': creds.get('llmModel') or server_llm['model'] or None,
                    # 让界面能显示「请求实际发去哪儿」，以及这个地址是用户填的还是自动认出来的
                    'baseUrl': client_llm['baseUrl'] if client_ok else server_llm['baseUrl'],
                    'baseUrlSource': client_llm['baseUrlSource'] if client_ok else server_llm['baseUrlSource'],
                    'providerName': client_llm['providerName'] if client_ok else server_llm['providerName'],
                    'imaConfigured': ima_enabled(creds),
                    'serverPreset': {'llm': server_llm['configured'],
                                     'ark': server_llm['configured'],
                                     'ima': ima_enabled({})},
                    'demo': (not client_ok) and not server_llm['configured'],
                    'sessions': len(sessions),
                })

            # 服务商预设表：前端下拉框直接用它渲染，避免两边各维护一份
            if pathname == '/api/providers' and method == 'GET':
                return self.send_json(200, {'ok': True, 'providers': PROVIDER_PRESETS})

            # 建/更新 ima 知识库索引（把书下载下来抽正文）。
            # 第一次用某个知识库会慢（要下书），所以给个独立入口让用户主动跑，
            # 而不是每次提问都干等。
            if pathname == '/api/ima/index' and method == 'POST':
                creds = creds_from_headers(self.headers)
                if not ima_enabled(creds):
                    return self.send_json(200, {'ok': False, 'error': '请先填写 ima API Key 与 Client ID'})
                body = self.read_body() or {}
                kb_map = creds.get('imaKbMap') or ''
                try:
                    kb_map = json.loads(kb_map) if isinstance(kb_map, str) else (kb_map or {})
                except Exception:
                    kb_map = {}
                kb = body.get('kbId') or (list(kb_map.values())[0] if kb_map else '')
                if not kb:
                    return self.send_json(200, {'ok': False, 'error': '还没有给学科绑定知识库'})
                c = ima_creds(creds)
                try:
                    stats = ima_index.build_index(
                        kb, c['apiKey'], c['clientId'],
                        budget_seconds=float(body.get('budget') or 240),
                        focus=str(body.get('focus') or ''),
                        force_relists=bool(body.get('refresh')),
                        reset=bool(body.get('reset') or body.get('refresh')))
                except Exception as err:
                    return self.send_json(200, {'ok': False, 'error': str(err)})
                st = ima_index.index_status(kb)
                return self.send_json(200, {
                    'ok': True, 'stats': stats, 'index': st,
                    'note': '共 %d 个文件，已解析 %d 本（%.1f 万字）%s%s' % (
                        st['listed'], st['ready'], st['chars'] / 10000.0,
                        ('，还有 %d 个待解析（再点一次继续）'
                         % max(0, st['listed'] - st['ready'] - st['unreadable']))
                        if st['listed'] - st['ready'] - st['unreadable'] > 0 else '',
                        ('；%d 个读不了（扫描版/图片版/网页笔记）' % st['unreadable'])
                        if st['unreadable'] else ''),
                })

            if pathname == '/api/ima/index' and method == 'GET':
                creds = creds_from_headers(self.headers)
                kb_map = creds.get('imaKbMap') or ''
                try:
                    kb_map = json.loads(kb_map) if isinstance(kb_map, str) else (kb_map or {})
                except Exception:
                    kb_map = {}
                kb = list(kb_map.values())[0] if kb_map else ''
                if not kb:
                    return self.send_json(200, {'ok': False, 'error': '还没有给学科绑定知识库'})
                return self.send_json(200, {'ok': True, 'index': ima_index.index_status(kb)})

            if pathname == '/api/state' and method == 'GET':
                entry, cookie = self.session_for()
                return self.send_json(200, entry['session'].status(),
                                      self._cookie_header(cookie))

            if pathname == '/api/chat' and method == 'POST':
                body = self.read_body()
                entry, cookie = self.session_for()
                result = entry['gm'].say(body.get('message') or '',
                                         creds_from_headers(self.headers), entry['corpus'])
                return self.send_json(200, result, self._cookie_header(cookie))

            # ── 用户自带教材（只放本会话内存，不落盘）──
            if pathname == '/api/corpus' and method == 'GET':
                entry, cookie = self.session_for()
                return self.send_json(200, corpus_view(entry), self._cookie_header(cookie))

            if pathname == '/api/corpus' and method == 'POST':
                body = self.read_body(8000000)
                entry, cookie = self.session_for()
                incoming = body.get('files') if isinstance(body.get('files'), list) else []
                if body.get('replace') is True:
                    entry['corpus'] = []

                for f in incoming[:30]:
                    name = str(f.get('name') or '未命名')[:160]
                    text = str(f.get('text') or '')
                    if not text.strip():
                        continue
                    if len(text) > MAX_FILE_CHARS:
                        text = text[:MAX_FILE_CHARS]
                    subject = str(f.get('subject'))[:40] if f.get('subject') else ''

                    # 同名文件视为更新，避免重复上传堆积
                    existing = next((i for i, x in enumerate(entry['corpus'])
                                     if x['name'] == name), -1)
                    item = {'id': str(uuid.uuid4()), 'name': name,
                            'subject': subject, 'text': text}
                    if existing >= 0:
                        item['id'] = entry['corpus'][existing]['id']
                        entry['corpus'][existing] = item
                    else:
                        entry['corpus'].append(item)

                # 总量封顶
                total = 0
                kept = []
                for f in entry['corpus']:
                    if total >= MAX_CORPUS_CHARS:
                        break
                    kept.append(f)
                    total += len(f['text'])
                entry['corpus'] = kept

                view = corpus_view(entry)
                view['truncated'] = total >= MAX_CORPUS_CHARS
                return self.send_json(200, view, self._cookie_header(cookie))

            # 给单个文件打「学科」标签（空字符串 = 通用教材）
            if pathname == '/api/corpus' and method == 'PATCH':
                body = self.read_body()
                entry, cookie = self.session_for()
                item = next((f for f in entry['corpus'] if f['id'] == body.get('id')), None)
                if not item:
                    return self.send_json(404, {'ok': False, 'error': '未找到该教材文件'},
                                          self._cookie_header(cookie))
                item['subject'] = str(body.get('subject'))[:40] if body.get('subject') else ''
                return self.send_json(200, corpus_view(entry), self._cookie_header(cookie))

            # 删除单个（带 ?id=）或全部
            if pathname == '/api/corpus' and method == 'DELETE':
                entry, cookie = self.session_for()
                file_id = (query.get('id') or [None])[0]
                if file_id:
                    entry['corpus'] = [f for f in entry['corpus'] if f['id'] != file_id]
                else:
                    entry['corpus'] = []
                return self.send_json(200, corpus_view(entry), self._cookie_header(cookie))

            # ── ima：列出可用知识库（把「名称」解析成「ID」）──
            if pathname == '/api/ima/kbs' and method == 'POST':
                r = list_knowledge_bases(creds_from_headers(self.headers))
                return self.send_json(200, r)

            if pathname == '/api/reset' and method == 'POST':
                entry, cookie = self.session_for()
                entry['gm'].reset()
                return self.send_json(200, {'ok': True, 'state': entry['session'].status()},
                                      self._cookie_header(cookie))

            # ── 学科管理：用户可以自主增删（通常按自己的 ima 知识库来建）──
            if pathname == '/api/subjects' and method == 'POST':
                body = self.read_body()
                entry, cookie = self.session_for()
                r = entry['session'].add_subject(body.get('name'))
                out = dict(r)
                out['subjects'] = list(entry['session'].state['subjects'].keys())
                return self.send_json(200 if r['ok'] else 400, out, self._cookie_header(cookie))

            if pathname == '/api/subjects' and method == 'DELETE':
                entry, cookie = self.session_for()
                r = entry['session'].remove_subject((query.get('name') or [''])[0])
                out = dict(r)
                out['subjects'] = list(entry['session'].state['subjects'].keys())
                return self.send_json(200 if r['ok'] else 400, out, self._cookie_header(cookie))

            # 连通性测试：用请求头里的凭证真调一次，判断填得对不对
            if pathname == '/api/test' and method == 'POST':
                body = self.read_body()
                creds = creds_from_headers(self.headers)
                kind = body.get('kind') or 'llm'
                if kind == 'ima':
                    r = test_ima(creds)
                    return self.send_json(200, {'ok': r.get('ok') is True,
                                                'kind': 'ima', 'detail': r})
                if not (creds.get('llmApiKey') and creds.get('llmModel')):
                    return self.send_json(200, {'ok': False, 'kind': 'llm',
                                                'error': '请先填写 API Key 与模型 ID'})
                try:
                    r = llm_chat([{'role': 'user', 'content': '只回复两个字：收到'}],
                                 {'creds': creds, 'temperature': 0, 'timeoutMs': 30000})
                    return self.send_json(200, {'ok': True, 'kind': 'llm',
                                                'reply': r['content']})
                except Exception as err:
                    return self.send_json(200, {'ok': False, 'kind': 'llm',
                                                'error': str(err)})

            # ── 静态 UI ──
            if method in ('GET', 'HEAD'):
                return self.serve_static(pathname)

            self._send(405, 'method not allowed', 'text/plain; charset=utf-8')
        except Exception as err:
            self.send_json(500, {'ok': False, 'error': str(err)})

    @staticmethod
    def _cookie_header(cookie):
        return {'set-cookie': cookie} if cookie else None

    def do_GET(self):
        self.dispatch()

    def do_HEAD(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def do_PATCH(self):
        self.dispatch()

    def do_DELETE(self):
        self.dispatch()


def _port_in_use(host, port):
    """探测端口是否已被占用。

    必须自己探测：Windows 的 SO_REUSEADDR 语义允许第二个进程绑定到已占用的端口
    （Linux 上会直接报错），于是「重复启动」会静默成功、请求却可能打到旧进程上——
    对使用者来说表现为「改了代码重启却没生效」。这里显式拦掉。
    """
    import socket
    probe_host = '127.0.0.1' if host in ('0.0.0.0', '::', '') else host
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.6)
            return s.connect_ex((probe_host, port)) == 0
    except OSError:
        return False


def main():
    if _port_in_use(HOST, PORT):
        print('')
        print('  [X] 启动失败：端口 %s 已经被占用。' % PORT)
        print('')
        print('    最常见的原因：你已经开着一个了（可能就在另一个命令行窗口里）。')
        print('')
        print('    怎么办，二选一：')
        print('      1) 想关掉旧的：回到那个命令行窗口，按 Ctrl + C。')
        print('      2) 想同时开第二个：换个端口再启动，例如：')
        print('           set PORT=8788')
        print('           python run.py')
        print('')
        print('    提示：端口被谁占了，可用这条命令查（PowerShell）：')
        print('           Get-NetTCPConnection -LocalPort %s -State Listen' % PORT)
        print('')
        return 1

    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        print('')
        print('  [X] 启动失败：无法监听 %s:%s' % (HOST, PORT))
        print('    系统错误：%s' % e)
        print('    若是权限问题，可改用 1024 以上的端口（见上）。')
        print('')
        return 1

    server.daemon_threads = True
    server_llm = describe_llm({})
    mode = ('服务端预置大模型（模型：%s，%s）—— 也可由访客自带 Key 覆盖'
            % (server_llm['model'], server_llm['baseUrl'])
            if server_llm['configured']
            else 'BYOK 模式（服务端未放任何 Key，由每位访客自带凭证）')
    print('')
    print('  [OK] 学术galgame Agent（Python 版）已启动')
    print('')
    print('    请在浏览器打开：  http://%s:%s' % (HOST, PORT))
    print('    模型来源：%s' % mode)
    print('    配置文件：%s' % (ENV_FILE if ENV_LOADED else '%s（不存在，已跳过）' % ENV_FILE))
    print('')
    print('    停止服务：在本窗口按 Ctrl + C')
    print('')

    # 自动打开浏览器（仅在设置了 GALGAME_OPEN=1 时）。
    # 给「双击启动」这种零输入场景用：省掉「再手动开浏览器、敲地址」这一步。
    if os.environ.get('GALGAME_OPEN') == '1':
        import webbrowser
        open_host = '127.0.0.1' if HOST in ('0.0.0.0', '::', '') else HOST
        url = 'http://%s:%s' % (open_host, PORT)
        try:
            webbrowser.open(url)
            print('    已尝试为你打开浏览器：%s' % url)
            print('    （没弹出来的话，手动打开浏览器输入这个地址即可）')
            print('')
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  已停止。\n')
    finally:
        server.server_close()
    return 0
