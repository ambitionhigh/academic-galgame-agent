# -*- coding: utf-8 -*-
"""大模型客户端 —— 面向**任意 OpenAI 兼容接口**（纯标准库 urllib）。

使用 POST {baseUrl}/chat/completions + Bearer 鉴权，因此不绑定任何一家供应商。

【为什么要「猜」服务商】
Base URL 留空时如果静默回落到火山方舟，那么用 DeepSeek Key 的人会拿到一个
莫名其妙的 401（提示"API key format is incorrect"），看起来就像"这软件只认火山引擎"。
所以现在的规则是：
  · 填了 Base URL        → 就用它（最优先，永远是权威）
  · 没填，但模型名能认出  → 自动补上对应服务商的地址（会在 UI 上标明"已自动识别"）
  · 没填，也认不出来      → 明确报错，让人去填 Base URL，而不是偷偷发去火山方舟
"""

import json
import os
import urllib.error
import urllib.request

# ── 服务商预设（前端下拉框也从这里取，保证两边永远一致） ──────────────
PROVIDER_PRESETS = [
    {'id': 'deepseek', 'name': 'DeepSeek', 'baseUrl': 'https://api.deepseek.com',
     'model': 'deepseek-chat', 'hint': '便宜好用，国内可直连'},
    {'id': 'ark', 'name': '火山方舟（火山引擎）', 'baseUrl': 'https://ark.cn-beijing.volces.com/api/v3',
     'model': '', 'modelHint': 'ep-xxxxxxxx（推理接入点 ID，不是模型名）',
     'hint': '模型名要填你创建的推理接入点'},
    {'id': 'moonshot', 'name': '月之暗面 Kimi', 'baseUrl': 'https://api.moonshot.cn/v1',
     'model': 'moonshot-v1-8k', 'hint': ''},
    {'id': 'zhipu', 'name': '智谱 GLM', 'baseUrl': 'https://open.bigmodel.cn/api/paas/v4',
     'model': 'glm-4-flash', 'hint': ''},
    {'id': 'dashscope', 'name': '阿里通义千问', 'baseUrl': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
     'model': 'qwen-plus', 'hint': ''},
    {'id': 'siliconflow', 'name': '硅基流动', 'baseUrl': 'https://api.siliconflow.cn/v1',
     'model': 'deepseek-ai/DeepSeek-V3', 'hint': ''},
    {'id': 'openai', 'name': 'OpenAI', 'baseUrl': 'https://api.openai.com/v1',
     'model': 'gpt-4o-mini', 'hint': '国内需自备网络环境'},
    {'id': 'custom', 'name': '其它 / 自定义', 'baseUrl': '', 'model': '',
     'hint': '任何 OpenAI 兼容地址都行，填到 /v1 这一层'},
]

_BY_ID = {p['id']: p for p in PROVIDER_PRESETS}

# 模型名特征 → 服务商。顺序有意义：先匹配到的先用。
_MODEL_RULES = [
    ('ep-', 'ark'),
    ('deepseek', 'deepseek'),
    ('moonshot', 'moonshot'),
    ('kimi', 'moonshot'),
    ('glm', 'zhipu'),
    ('charglm', 'zhipu'),
    ('qwen', 'dashscope'),
    ('tongyi', 'dashscope'),
    ('gpt', 'openai'),
    ('chatgpt', 'openai'),
    ('o1', 'openai'),
    ('o3', 'openai'),
    ('o4', 'openai'),
]


def preset_base(provider_id):
    return (_BY_ID.get(provider_id) or {}).get('baseUrl') or ''


def infer_provider(model):
    """从模型名猜服务商；猜不出来返回 ''。"""
    m = (model or '').strip().lower()
    if not m:
        return ''
    if '/' in m:                      # 形如 deepseek-ai/DeepSeek-V3 → 聚合平台
        return 'siliconflow'
    for prefix, pid in _MODEL_RULES:
        if m.startswith(prefix):
            return pid
    return ''


def _pick(*values):
    """取第一个非空字符串（用于「新名字优先、旧名字兜底」）。"""
    for v in values:
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ''


def llm_settings(creds=None):
    """解析生效的大模型配置。

    返回的 baseUrlSource 有三种：
      client / server  —— 用户或服务端明确填了地址
      inferred         —— 没填，但根据模型名自动识别出来了
      missing          —— 没填也认不出来，调用时会明确报错
    """
    creds = creds or {}
    api_key = _pick(creds.get('llmApiKey'), creds.get('arkApiKey'),
                    os.environ.get('LLM_API_KEY'), os.environ.get('ARK_API_KEY'))
    model = _pick(creds.get('llmModel'), creds.get('arkModel'),
                  os.environ.get('LLM_MODEL'), os.environ.get('ARK_MODEL'))

    explicit = _pick(creds.get('llmBaseUrl'), creds.get('arkBaseUrl'))
    client_key = _pick(creds.get('llmApiKey'), creds.get('arkApiKey'))
    server_base = _pick(os.environ.get('LLM_BASE_URL'), os.environ.get('ARK_BASE_URL'))

    if explicit:
        # ① 用户自己填了地址 —— 永远最优先
        base_url, base_source, provider = explicit.rstrip('/'), 'client', ''
    elif client_key:
        # ② 用户自带 Key，但没填地址 —— 只能按模型名认。
        #    这里**绝不套用服务端预置地址**：那正是「用 DeepSeek Key 却被发去火山方舟」
        #    然后报 401 的根源。认不出来就老实报错，让人去填。
        provider = infer_provider(model)
        base_url = preset_base(provider)
        base_source = 'inferred' if base_url else 'missing'
    elif server_base:
        # ③ 用服务端的 Key，那就用服务端的地址
        base_url, base_source, provider = server_base.rstrip('/'), 'server', ''
    else:
        provider = infer_provider(model)
        base_url = preset_base(provider)
        base_source = 'inferred' if base_url else 'missing'

    if client_key:
        source = 'client'
    elif _pick(os.environ.get('LLM_API_KEY'), os.environ.get('ARK_API_KEY')):
        source = 'server'
    else:
        source = 'none'

    return {'baseUrl': base_url, 'apiKey': api_key, 'model': model,
            'source': source, 'baseUrlSource': base_source, 'provider': provider}


def is_llm_configured(creds=None):
    """是否已配置大模型（未配置时上层进入 demo 模式）。"""
    s = llm_settings(creds)
    return bool(s['apiKey'] and s['model'])


def describe_llm(creds=None):
    """只返回不含密钥的可公开信息（给 UI 显示用）。"""
    s = llm_settings(creds)
    name = (_BY_ID.get(s['provider']) or {}).get('name') or ''
    return {'configured': bool(s['apiKey'] and s['model']),
            'model': s['model'] or None,
            'baseUrl': s['baseUrl'] or None,
            'baseUrlSource': s['baseUrlSource'],
            'provider': s['provider'],
            'providerName': name,
            'source': s['source']}


# ── 错误翻译：把英文原始报错变成能照着做的话 ────────────────────────

def _explain_http(code, base_url, detail):
    where = '%s/chat/completions' % base_url
    raw = (detail or '').strip()
    short = raw[:300]

    if code == 401:
        return ('认证失败（HTTP 401）。两种可能：\n'
                '  ① API Key 填错了或不完整；\n'
                '  ② Key 是别家的，但 Base URL 指向了 %s。\n'
                '请到「⚙ 设置」核对：先选对服务商（或手填 Base URL），再填 Key。\n'
                '服务端原话：%s') % (base_url, short)
    if code == 403:
        return ('被拒绝（HTTP 403）：Key 没有调用该模型的权限，或模型未开通。\n'
                '  当前地址：%s\n服务端原话：%s') % (where, short)
    if code == 404:
        return ('地址不存在（HTTP 404）：%s\n'
                'Base URL 一般填到 /v1 这一层就够了，不要带 /chat/completions。\n'
                '例如 DeepSeek 是 https://api.deepseek.com，OpenAI 是 https://api.openai.com/v1。\n'
                '服务端原话：%s') % (where, short)
    if code == 429:
        return ('请求太频繁或额度用尽（HTTP 429）。稍后再试，或检查账户余额。\n'
                '服务端原话：%s') % short
    if code == 400:
        return ('服务端说请求有问题（HTTP 400）——最常见的原因是**模型名不对**。\n'
                '  当前模型名：见设置里的「模型 ID」；当前地址：%s\n'
                '  火山方舟要填推理接入点（ep-…），DeepSeek 是 deepseek-chat。\n'
                '服务端原话：%s') % (where, short)
    if code in (500, 502, 503, 504):
        return '服务端故障（HTTP %s），不是你的配置问题，稍后再试。%s' % (code, short)
    return '大模型请求失败（HTTP %s，%s）：%s' % (code, where, short)


def llm_chat(messages, options=None):
    """调用大模型对话补全。

    messages: OpenAI 格式消息数组
    options : {'creds': dict, 'tools': list, 'toolChoice': str,
               'temperature': float, 'timeoutMs': int}
    返回 {'content': str, 'toolCalls': list, 'raw': dict}
    未配置时抛 RuntimeError('LLM_NOT_CONFIGURED')
    """
    options = options or {}
    s = llm_settings(options.get('creds') or {})
    if not s['apiKey'] or not s['model']:
        raise RuntimeError('LLM_NOT_CONFIGURED')
    if not s['baseUrl']:
        raise RuntimeError(
            '不知道要把请求发去哪儿：Base URL 没填，而且从模型名「%s」也认不出是哪家服务。\n'
            '请打开「⚙ 设置」，在①里选一个服务商（会自动填好地址），或手动填 Base URL。' % s['model'])

    body = {'model': s['model'], 'messages': messages}
    tools = options.get('tools')
    if tools:
        body['tools'] = tools
        body['tool_choice'] = options.get('toolChoice') or 'auto'
    if isinstance(options.get('temperature'), (int, float)) and not isinstance(options.get('temperature'), bool):
        body['temperature'] = options['temperature']

    timeout = (options.get('timeoutMs') or 120000) / 1000.0
    req = urllib.request.Request(
        '%s/chat/completions' % s['baseUrl'],
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers={'content-type': 'application/json',
                 'authorization': 'Bearer %s' % s['apiKey']},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = ''
        try:
            detail = e.read().decode('utf-8', 'replace')
        except Exception:
            pass
        raise RuntimeError(_explain_http(e.code, s['baseUrl'], detail))
    except urllib.error.URLError as e:
        raise RuntimeError(
            '连不上 %s（%s）。\n'
            '检查：网络是否通、地址是否写对、有没有需要代理。' % (s['baseUrl'], e.reason))

    choices = payload.get('choices') or [{}]
    message = (choices[0] or {}).get('message') or {}
    return {
        'content': message.get('content') or '',
        'toolCalls': message.get('tool_calls') or [],
        'raw': payload,
    }
