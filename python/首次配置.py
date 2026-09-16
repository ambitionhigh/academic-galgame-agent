# -*- coding: utf-8 -*-
"""首次配置向导：问一次，写进 .env，以后就一直是真 AI 老师。

为什么需要它：不配模型时程序跑在 DEMO 模式，老师的回复是几条写死的示例，
无论你输入什么都不会变。使用者容易误以为「这东西不智能」。

本向导做的事：
  1. 问你要用哪家服务（给预设好的 Base URL 与模型名，不用你自己查）
  2. 收下你的 API Key
  3. **当场真调一次**，把结果告诉你（成功/失败都给明确原因）
  4. 写进本目录的 .env（已被 .gitignore 忽略，不会提交到 Git）

全程只用到标准库，不联网下载任何东西（除了测试时调用你自己的模型接口）。
"""

import io
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(HERE, '.env')

# 预设：让使用者不用自己去查地址和模型名
PROVIDERS = {
    '1': {
        'name': 'DeepSeek',
        'base': 'https://api.deepseek.com',
        'model': 'deepseek-chat',
        'hint': '在 https://platform.deepseek.com 的「API Keys」页面创建，形如 sk-xxxxxxxx',
        'tip': '便宜、申请简单，推荐新手',
    },
    '2': {
        'name': '火山方舟（火山引擎）',
        'base': 'https://ark.cn-beijing.volces.com/api/v3',
        'model': '',
        'hint': '在 https://console.volcengine.com/ark 创建 API Key，'
                '再到「在线推理」建一个接入点，拿到 ep- 开头的 ID 作为模型名',
        'tip': '模型名要填 ep- 开头的接入点 ID，不是模型的名字',
    },
    '3': {
        'name': '其它 OpenAI 兼容服务',
        'base': '',
        'model': '',
        'hint': '填对方给你的 Base URL 与模型名',
        'tip': '只要接口是 OpenAI 兼容就能用',
    },
}


def line(text=''):
    print(text)


def ask(prompt, default=''):
    """读一行输入；直接回车就用默认值。"""
    try:
        raw = input(prompt).strip()
    except (EOFError, KeyboardInterrupt):
        line()
        line('  已取消。')
        sys.exit(1)
    return raw or default


def test_model(base, model, key):
    """用给定凭证真调一次，返回 (ok, 说明)。"""
    body = {
        'model': model,
        'messages': [{'role': 'user', 'content': '只回复两个字：收到'}],
        'temperature': 0,
    }
    req = urllib.request.Request(
        '%s/chat/completions' % base.rstrip('/'),
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers={'content-type': 'application/json',
                 'authorization': 'Bearer %s' % key},
        method='POST')
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
        choices = payload.get('choices') or [{}]
        content = ((choices[0] or {}).get('message') or {}).get('content') or ''
        return True, content.strip() or '（模型返回了空内容，但连接是通的）'
    except urllib.error.HTTPError as e:
        detail = ''
        try:
            detail = e.read().decode('utf-8', 'replace')[:300]
        except Exception:
            pass
        if e.code == 401:
            why = 'API Key 不对（可能没复制全，或首尾多了空格）'
        elif e.code == 404:
            why = '模型名不对，或这个模型你没开通'
        elif e.code == 403:
            why = '账号没实名 / 没开通这个模型'
        elif e.code == 429:
            why = '请求太频繁或额度用完了'
        else:
            why = '服务端返回错误'
        return False, '%s（HTTP %s）\n        原始信息：%s' % (why, e.code, detail)
    except urllib.error.URLError as e:
        return False, '连不上这个地址：%s\n        检查网络，或确认 Base URL 没写错' % (e.reason,)
    except Exception as e:
        return False, '出错了：%s' % (e,)


def read_existing():
    """读现有 .env 里的模型配置（用于「保持现状」）。"""
    out = {}
    if not os.path.exists(ENV_PATH):
        return out
    try:
        with io.open(ENV_PATH, encoding='utf-8') as fh:
            for raw in fh:
                s = raw.strip()
                if not s or s.startswith('#') or '=' not in s:
                    continue
                k, v = s.split('=', 1)
                out[k.strip()] = v.strip()
    except OSError:
        pass
    return out


def write_env(base, model, key):
    """写 .env；保留文件里其它行（如 PORT/HOST）。"""
    keep = []
    if os.path.exists(ENV_PATH):
        try:
            with io.open(ENV_PATH, encoding='utf-8') as fh:
                for raw in fh:
                    s = raw.strip()
                    if s.startswith(('LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL',
                                     'ARK_API_KEY', 'ARK_MODEL', 'ARK_BASE_URL')):
                        continue
                    keep.append(raw.rstrip('\n'))
        except OSError:
            pass
    body = [
        '# 由「首次配置」向导生成。本文件已被 .gitignore 忽略，不会提交到 Git。',
        'LLM_API_KEY=%s' % key,
        'LLM_MODEL=%s' % model,
        'LLM_BASE_URL=%s' % base,
    ]
    text = '\n'.join(body + [''] + [k for k in keep if k.strip()]) + '\n'
    with io.open(ENV_PATH, 'w', encoding='utf-8', newline='') as fh:
        fh.write(text)


def main():
    line()
    line('  ==========================================')
    line('     学术galgame Agent  ·  首次配置')
    line('  ==========================================')
    line()
    line('  这个程序需要一个「大模型」才能真正上课。')
    line('  不配的话，老师只会重复几句写死的话（DEMO 模式），')
    line('  看起来就像「不智能」。')
    line()

    existing = read_existing()
    if existing.get('LLM_API_KEY') or existing.get('ARK_API_KEY'):
        now_model = existing.get('LLM_MODEL') or existing.get('ARK_MODEL') or '(未填)'
        line('  检测到你已经配置过：')
        line('    模型：%s' % now_model)
        line('    地址：%s' % (existing.get('LLM_BASE_URL') or existing.get('ARK_BASE_URL') or '(默认)'))
        line()
        if ask('  要保持现状吗？(Y/n) ', 'y').lower() in ('y', 'yes', '是', ''):
            line()
            line('  好的，保持现状。直接运行「启动.bat」即可。')
            line()
            return 0
        line()

    line('  请选择你要用的大模型服务：')
    line()
    for k in sorted(PROVIDERS):
        p = PROVIDERS[k]
        line('    %s. %s' % (k, p['name']))
        line('       %s' % p['tip'])
    line('    0. 先跳过（继续用 DEMO 模式玩）')
    line()

    choice = ask('  输入数字后回车 [1]: ', '1')
    if choice == '0':
        line()
        line('  好的，跳过配置。想配的时候再双击「首次配置.bat」。')
        line()
        return 0
    if choice not in PROVIDERS:
        line()
        line('  没看懂「%s」，我按 1（DeepSeek）继续了。' % choice)
        choice = '1'

    p = PROVIDERS[choice]
    line()
    line('  ── 你选择了：%s ──' % p['name'])
    line()

    base = p['base']
    model = p['model']

    if choice == '2':
        model = ask('  模型 ID（ep- 开头的接入点 ID）： ')
    elif choice == '3':
        base = ask('  Base URL（例如 https://api.deepseek.com）： ')
        model = ask('  模型名（例如 deepseek-chat）： ')
    else:
        line('  地址：%s' % base)
        line('  模型：%s' % model)
        line()

    line('  %s' % p['hint'])
    line()
    key = ask('  请粘贴你的 API Key，然后回车： ')
    if not key:
        line()
        line('  没有填 Key，配置取消。')
        line()
        return 1

    line()
    line('  正在测试连接，最多等 45 秒...')
    ok, msg = test_model(base, model, key)

    if not ok:
        line()
        line('  [X] 没连上：')
        line('        %s' % msg)
        line()
        line('  没有写入配置。可以重新双击「首次配置.bat」再试一次。')
        line()
        return 1

    write_env(base, model, key)
    line()
    line('  [OK] 连接成功！模型返回：%s' % msg)
    line()
    line('  配置已保存到：%s' % ENV_PATH)
    line('  （这个文件不会被上传到网上）')
    line()
    line('  现在双击「启动.bat」，老师就是真的 AI 了。')
    line('  故意答错一次试试 —— 它会追问你，而不是直接给答案。')
    line()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        line()
        line('  已取消。')
        sys.exit(1)
