# -*- coding: utf-8 -*-
"""大模型客户端 —— 面向**任意 OpenAI 兼容接口**（纯标准库 urllib）。

使用 POST {baseUrl}/chat/completions + Bearer 鉴权，因此不绑定任何一家供应商。

已实测可用的例子：
  · DeepSeek：https://api.deepseek.com ，模型 deepseek-chat
  · 火山引擎 · 火山方舟（Base URL 留空时的默认值）：https://ark.cn-beijing.volces.com/api/v3 ，模型形如 ep-xxxxxxxx
  · 其它任何 OpenAI 兼容服务：填它的 Base URL 与模型名即可

【BYOK 自带密钥】凭证优先取「本次请求传入的 creds」，其次回落到服务端环境变量：
  creds['llmApiKey'] / creds['llmModel'] / creds['llmBaseUrl']
  <- 环境变量 LLM_API_KEY / LLM_MODEL / LLM_BASE_URL
  （为兼容早期版本，同时接受 creds['arkApiKey'] 与 ARK_* 环境变量作为别名）
公开部署时**不要**在服务端配置凭证，让每位访客用自己的 Key（服务端不存储任何凭证）。
"""

import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'


def _pick(*values):
    """取第一个非空字符串（用于「新名字优先、旧名字兜底」）。"""
    for v in values:
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ''


def llm_settings(creds=None):
    """解析生效的大模型配置。"""
    creds = creds or {}
    api_key = _pick(creds.get('llmApiKey'), creds.get('arkApiKey'),
                    os.environ.get('LLM_API_KEY'), os.environ.get('ARK_API_KEY'))
    model = _pick(creds.get('llmModel'), creds.get('arkModel'),
                  os.environ.get('LLM_MODEL'), os.environ.get('ARK_MODEL'))
    base_url = _pick(creds.get('llmBaseUrl'), creds.get('arkBaseUrl'),
                     os.environ.get('LLM_BASE_URL'), os.environ.get('ARK_BASE_URL'),
                     DEFAULT_BASE_URL).rstrip('/')
    # 凭证来源，便于 UI 提示「你在用自己填的 Key」还是「服务端预置」
    if _pick(creds.get('llmApiKey'), creds.get('arkApiKey')):
        source = 'client'
    elif _pick(os.environ.get('LLM_API_KEY'), os.environ.get('ARK_API_KEY')):
        source = 'server'
    else:
        source = 'none'
    return {'baseUrl': base_url, 'apiKey': api_key, 'model': model, 'source': source}


def is_llm_configured(creds=None):
    """是否已配置大模型（未配置时上层进入 demo 模式）。"""
    s = llm_settings(creds)
    return bool(s['apiKey'] and s['model'])


def describe_llm(creds=None):
    """只返回不含密钥的可公开信息。"""
    s = llm_settings(creds)
    return {'configured': bool(s['apiKey'] and s['model']),
            'model': s['model'] or None,
            'baseUrl': s['baseUrl'],
            'source': s['source']}


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
            detail = e.read().decode('utf-8', 'replace')[:500]
        except Exception:
            pass
        raise RuntimeError('大模型请求失败（HTTP %s，%s）：%s' % (e.code, s['baseUrl'], detail))
    except urllib.error.URLError as e:
        raise RuntimeError('大模型请求失败（%s）：%s' % (s['baseUrl'], e.reason))

    choices = payload.get('choices') or [{}]
    message = (choices[0] or {}).get('message') or {}
    return {
        'content': message.get('content') or '',
        'toolCalls': message.get('tool_calls') or [],
        'raw': payload,
    }
