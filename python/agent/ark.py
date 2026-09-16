# -*- coding: utf-8 -*-
"""火山引擎 · 火山方舟（Volcengine Ark）客户端 —— 纯标准库实现（urllib）。

使用方舟的 OpenAI 兼容接口：POST {baseUrl}/chat/completions

【BYOK 自带密钥】凭证优先取「本次请求传入的 creds」，其次回落到服务端环境变量：
  creds['arkApiKey'] / creds['arkModel'] / creds['arkBaseUrl']
  <- 环境变量 ARK_API_KEY / ARK_MODEL / ARK_BASE_URL
公开部署时**不要**在服务端配置凭证，让每位访客用自己的 Key（服务端不存储任何凭证）。

注：本客户端打的是标准 OpenAI 兼容端点，改 baseUrl 即可指向其它兼容服务。
"""

import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'


def ark_settings(creds=None):
    """解析生效的方舟配置。"""
    creds = creds or {}
    base_url = (creds.get('arkBaseUrl') or os.environ.get('ARK_BASE_URL')
                or DEFAULT_BASE_URL).rstrip('/')
    api_key = creds.get('arkApiKey') or os.environ.get('ARK_API_KEY') or ''
    model = creds.get('arkModel') or os.environ.get('ARK_MODEL') or ''
    # 凭证来源，便于 UI 提示「你在用自己填的 Key」还是「服务端预置」
    if creds.get('arkApiKey'):
        source = 'client'
    elif os.environ.get('ARK_API_KEY'):
        source = 'server'
    else:
        source = 'none'
    return {'baseUrl': base_url, 'apiKey': api_key, 'model': model, 'source': source}


def is_ark_configured(creds=None):
    """是否已配置方舟（未配置时上层进入 demo 模式）。"""
    s = ark_settings(creds)
    return bool(s['apiKey'] and s['model'])


def describe_ark(creds=None):
    """只返回不含密钥的可公开信息。"""
    s = ark_settings(creds)
    return {'configured': bool(s['apiKey'] and s['model']),
            'model': s['model'] or None,
            'baseUrl': s['baseUrl'],
            'source': s['source']}


def ark_chat(messages, options=None):
    """调用方舟对话补全。

    messages: OpenAI 格式消息数组
    options : {'creds': dict, 'tools': list, 'toolChoice': str,
               'temperature': float, 'timeoutMs': int}
    返回 {'content': str, 'toolCalls': list, 'raw': dict}
    未配置时抛 RuntimeError('ARK_NOT_CONFIGURED')
    """
    options = options or {}
    s = ark_settings(options.get('creds') or {})
    if not s['apiKey'] or not s['model']:
        raise RuntimeError('ARK_NOT_CONFIGURED')

    body = {'model': s['model'], 'messages': messages}
    tools = options.get('tools')
    if tools:
        body['tools'] = tools
        body['tool_choice'] = options.get('toolChoice') or 'auto'
    if isinstance(options.get('temperature'), (int, float)):
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
            detail = e.read().decode('utf-8', 'replace')[:500]
        except Exception:
            pass
        raise RuntimeError('火山方舟请求失败（HTTP %s）：%s' % (e.code, detail))
    except urllib.error.URLError as e:
        raise RuntimeError('火山方舟请求失败：%s' % (e.reason,))

    choices = payload.get('choices') or [{}]
    message = (choices[0] or {}).get('message') or {}
    return {
        'content': message.get('content') or '',
        'toolCalls': message.get('tool_calls') or [],
        'raw': payload,
    }
