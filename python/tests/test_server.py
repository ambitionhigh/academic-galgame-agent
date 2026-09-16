# -*- coding: utf-8 -*-
"""HTTP 层自测：真起一个服务，走真实 HTTP 请求（不联网、不调模型）。

这一组不在 Node 版的 12 项自测里 —— 因为 Python 版把 HTTP 层也重写了，
需要单独验证接口契约与前端一致（前端一行未改，接口必须对得上）。

运行：python -m unittest discover -s tests -v
"""

import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.server import Handler          # noqa: E402


class TestHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.httpd.daemon_threads = True
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.cookie = None

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def call(self, path, method='GET', body=None, headers=None):
        url = 'http://127.0.0.1:%d%s' % (self.port, path)
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers=headers or {})
        if data is not None:
            req.add_header('content-type', 'application/json')
        if self.cookie:
            req.add_header('cookie', self.cookie)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = resp.read().decode('utf-8')
                set_cookie = resp.headers.get('set-cookie')
                if set_cookie:
                    TestHttp.cookie = set_cookie.split(';')[0]
                return resp.status, json.loads(raw) if raw.startswith(('{', '[')) else raw
        except urllib.error.HTTPError as e:
            raw = e.read().decode('utf-8')
            return e.code, json.loads(raw) if raw.startswith(('{', '[')) else raw

    def test_01_health(self):
        code, data = self.call('/api/health')
        self.assertEqual(code, 200)
        self.assertTrue(data['ok'])
        self.assertTrue(data['byok'])
        self.assertTrue(data['demo'], '未配置任何 Key 时应是 demo 模式')

    def test_02_state_has_five_subjects(self):
        code, data = self.call('/api/state')
        self.assertEqual(code, 200)
        self.assertEqual(data['level'], 1)
        self.assertEqual(len(data['subjects']), 5)
        self.assertIn('imageKey', data)

    def test_03_chat_demo_mode_applies(self):
        code, data = self.call('/api/chat', 'POST', {'message': '开始教学'})
        self.assertEqual(code, 200)
        self.assertTrue(data['demo'])
        self.assertTrue(len(data['reply']) > 0)
        self.assertTrue(any(e['name'] == 'ag_apply' for e in data['events']))

    def test_04_subjects_add_and_delete(self):
        code, data = self.call('/api/subjects', 'POST', {'name': '自动测试学科'})
        self.assertEqual(code, 200)
        self.assertTrue(data['ok'])
        self.assertIn('自动测试学科', data['subjects'])
        # 前端用 encodeURIComponent 编码查询参数，这里对齐同一行为
        code, data = self.call('/api/subjects?name=%s'
                               % urllib.parse.quote('自动测试学科'), 'DELETE')
        self.assertEqual(code, 200)
        self.assertNotIn('自动测试学科', data['subjects'])

    def test_05_corpus_crud(self):
        code, data = self.call('/api/corpus', 'POST',
                               {'files': [{'name': '测试教材.md',
                                           'text': '# 纳什均衡\n纳什均衡是博弈论的核心概念。'}]})
        self.assertEqual(code, 200)
        self.assertEqual(len(data['files']), 1)
        file_id = data['files'][0]['id']
        self.assertGreater(data['files'][0]['chars'], 0)

        code, data = self.call('/api/corpus', 'PATCH', {'id': file_id, 'subject': '博弈论'})
        self.assertEqual(code, 200)
        self.assertEqual(data['files'][0]['subject'], '博弈论')

        code, data = self.call('/api/corpus?id=%s' % file_id, 'DELETE')
        self.assertEqual(code, 200)
        self.assertEqual(len(data['files']), 0)

    def test_06_static_index_and_assets(self):
        for path in ('/', '/app.js', '/styles.css'):
            url = 'http://127.0.0.1:%d%s' % (self.port, path)
            with urllib.request.urlopen(url, timeout=10) as resp:
                self.assertEqual(resp.status, 200, path)
                self.assertGreater(len(resp.read()), 0, path)

    def test_07_path_traversal_blocked(self):
        url = 'http://127.0.0.1:%d/../run.py' % self.port
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                self.assertIn(resp.status, (403, 404))
        except urllib.error.HTTPError as e:
            self.assertIn(e.code, (403, 404))


if __name__ == '__main__':
    unittest.main(verbosity=2)
