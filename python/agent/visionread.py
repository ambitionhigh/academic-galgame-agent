# -*- coding: utf-8 -*-
"""用**视觉模型**读扫描页 —— 把 PDF 每一页渲染成图，直接让模型读。

为什么有这条路：
    扫描版 PDF 没有文字层，本地解析器一个字都抽不出来。传统解法是本地 OCR
    （MinerU 之类，要下几百 MB~几 GB 模型）。但如果手上的模型本身就能看图，
    **把页面当图片发过去**就行了 —— 不用下 OCR 模型，表格、图表、手写也能读。

两条路各有取舍：
    · 本地 OCR（MinerU）  全本地、一次装好；质量取决于模型
    · 视觉模型读页        零本地模型、立刻可用；按页调用（本地 Ollama 免费，
                          云端按 token 计费），**页面会发到模型服务商**

所以这里做成**可选**：配了才走，没配就完全不参与。

配置（放在本机的 .env 里 —— 这是**每台机器自己**的事，不要提交）：
    GALGAME_VISION_BASE    OpenAI 兼容地址
                           本地 Ollama：http://127.0.0.1:11434/v1
                           DeepSeek   ：https://api.deepseek.com
    GALGAME_VISION_MODEL   模型名，如 qwen3.5:4b / deepseek-chat
    GALGAME_VISION_KEY     API Key（本地 Ollama 不需要，留空即可）
    GALGAME_VISION_DPI     渲染精度，默认 150（越高越清楚也越慢）
    GALGAME_VISION_MAX_PAGES  单本最多读多少页，默认 40
    GALGAME_VISION_PROMPT  自定义提示词（可选）

渲染需要 pypdfium2（一个 ~3MB 的小轮子）。**没装的话这一路会自动跳过**，
行为与以前一模一样。
"""

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

DEFAULT_DPI = int(os.environ.get('GALGAME_VISION_DPI') or 150)
DEFAULT_MAX_PAGES = int(os.environ.get('GALGAME_VISION_MAX_PAGES') or 40)
PAGE_TIMEOUT = int(os.environ.get('GALGAME_VISION_TIMEOUT') or 180)

# 让模型只吐正文，别加解释 —— 抽取不是聊天
DEFAULT_PROMPT = (
    '把这张书页图片里的文字**完整、逐字**转写成纯文本，保持原有段落顺序。\n'
    '要求：\n'
    '· 只输出正文，不要任何解释、不要加「以下是」「这张图片」之类的话；\n'
    '· 不要翻译、不要改写、不要总结；\n'
    '· 看不清的字用 □ 代替，不要猜；\n'
    '· 如果整页没有文字（比如纯插图页），只回一个空行。'
)


def vision_config():
    """读取视觉模型配置。"""
    return {
        'base': (os.environ.get('GALGAME_VISION_BASE') or '').strip().rstrip('/'),
        'model': (os.environ.get('GALGAME_VISION_MODEL') or '').strip(),
        'key': (os.environ.get('GALGAME_VISION_KEY') or '').strip(),
        'dpi': DEFAULT_DPI,
        'maxPages': DEFAULT_MAX_PAGES,
        'prompt': os.environ.get('GALGAME_VISION_PROMPT') or DEFAULT_PROMPT,
    }


def vision_configured():
    c = vision_config()
    return bool(c['base'] and c['model'])


def renderer_available():
    """页面渲染器在不在（pypdfium2）。"""
    try:
        import pypdfium2  # noqa: F401
        return True
    except Exception:
        return False


def vision_available():
    """这一路能不能用：配置齐 + 渲染器在。"""
    return vision_configured() and renderer_available()


def status():
    """给自检/诊断用。"""
    c = vision_config()
    return {
        'configured': vision_configured(),
        'renderer': renderer_available(),
        'ready': vision_available(),
        'base': c['base'] or None,
        'model': c['model'] or None,
        'dpi': c['dpi'],
        'maxPages': c['maxPages'],
    }


# ══════════════════════════════════════════════════════════════════
#  渲染：PDF → 每页一张 PNG
# ══════════════════════════════════════════════════════════════════

def render_pdf(data, dpi=None, max_pages=None):
    """把 PDF 渲染成 PNG 列表。返回 (pages, note)：pages 是 bytes 列表。

    需要 pypdfium2；没装会抛 RuntimeError，由上层如实告诉用户。
    """
    try:
        import pypdfium2 as pdfium
    except Exception:
        raise RuntimeError('缺少页面渲染器 pypdfium2（pip install pypdfium2）')

    dpi = dpi or DEFAULT_DPI
    max_pages = max_pages or DEFAULT_MAX_PAGES
    scale = dpi / 72.0

    out = []
    pdf = pdfium.PdfDocument(data)
    try:
        n = len(pdf)
        for i in range(min(n, max_pages)):
            page = pdf[i]
            try:
                bitmap = page.render(scale=scale)
                pil = bitmap.to_pil()
                buf = _png_bytes(pil)
                out.append(buf)
            finally:
                try:
                    page.close()
                except Exception:
                    pass
    finally:
        try:
            pdf.close()
        except Exception:
            pass
    return out, ('共 %d 页，只读了前 %d 页' % (n, max_pages) if n > max_pages else '')


def _png_bytes(pil_image):
    """PIL 图 → PNG bytes（不依赖 Pillow 之外的任何东西）。"""
    import io
    bio = io.BytesIO()
    pil_image.save(bio, format='PNG', optimize=True)
    return bio.getvalue()


# ══════════════════════════════════════════════════════════════════
#  调用视觉模型
# ══════════════════════════════════════════════════════════════════

def transcribe_page(png_bytes, cfg=None, timeout=None):
    """把一页图片交给视觉模型，返回它读出来的文字。"""
    c = cfg or vision_config()
    if not (c['base'] and c['model']):
        raise RuntimeError('视觉模型未配置')

    b64 = base64.b64encode(png_bytes).decode('ascii')
    body = {
        'model': c['model'],
        'messages': [{
            'role': 'user',
            'content': [
                {'type': 'text', 'text': c['prompt']},
                {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + b64}},
            ],
        }],
        'temperature': 0,          # 抽取任务要确定性，不要发挥
        'max_tokens': 8000,
    }
    headers = {'content-type': 'application/json'}
    if c['key']:
        headers['authorization'] = 'Bearer ' + c['key']

    req = urllib.request.Request(
        c['base'] + '/chat/completions',
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers=headers, method='POST')

    try:
        with urllib.request.urlopen(req, timeout=timeout or PAGE_TIMEOUT) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = ''
        try:
            detail = e.read().decode('utf-8', 'replace')[:300]
        except Exception:
            pass
        raise RuntimeError('视觉模型返回 HTTP %s：%s' % (e.code, detail))
    except Exception as e:
        raise RuntimeError('连不上视觉模型 %s（%s）' % (c['base'], e))

    choices = payload.get('choices') or [{}]
    msg = (choices[0] or {}).get('message') or {}
    return (msg.get('content') or '').strip()


# ══════════════════════════════════════════════════════════════════
#  对外入口
# ══════════════════════════════════════════════════════════════════

def read_pdf(data, filename='', on_progress=None):
    """用视觉模型读整本 PDF。返回 (text, note)。

    note 非空表示不完整或失败 —— 由上层如实告诉用户，而不是假装读到了。
    """
    if not vision_configured():
        return '', '视觉模型未配置'
    if not renderer_available():
        return '', '缺少页面渲染器 pypdfium2（pip install pypdfium2）'

    c = vision_config()
    try:
        pages, page_note = render_pdf(data, c['dpi'], c['maxPages'])
    except Exception as e:
        return '', '渲染 PDF 失败：%s' % e
    if not pages:
        return '', '这本 PDF 渲染不出任何页面'

    parts = []
    failed = 0
    for i, png in enumerate(pages):
        try:
            t = transcribe_page(png, c)
        except Exception as e:
            failed += 1
            if on_progress:
                on_progress(i + 1, len(pages), '失败：%s' % e)
            continue
        if t:
            parts.append(t)
        if on_progress:
            on_progress(i + 1, len(pages), '%d 字' % len(t))

    text = '\n\n'.join(parts)
    if not text.strip():
        return '', '视觉模型没读出任何文字（读了 %d 页）' % len(pages)
    note = page_note
    if failed:
        note = (note + '；' if note else '') + '有 %d 页读取失败' % failed
    return text, note


def selftest():
    """自检用：报告这一路的状态，能连就顺手试一页。"""
    st = status()
    if not st['ready']:
        st['note'] = ('未配置 GALGAME_VISION_BASE/MODEL' if not st['configured']
                      else '缺少 pypdfium2（pip install pypdfium2）')
        return st
    # 造一张只有一行字的图，看看模型能不能读出来
    try:
        png = _probe_image()
        got = transcribe_page(png, timeout=60)
        st['probe'] = got[:60]
        st['ok'] = '测试' in got or 'OK' in got.upper()
    except Exception as e:
        st['ok'] = False
        st['probe_error'] = str(e)
    return st


def _probe_image():
    """生成一张写着「测试」的 PNG —— 用 PIL 画，不依赖系统字体。"""
    try:
        from PIL import Image, ImageDraw
    except Exception:
        raise RuntimeError('自检需要 Pillow')
    img = Image.new('RGB', (240, 90), 'white')
    d = ImageDraw.Draw(img)
    d.rectangle([5, 5, 235, 85], outline='black', width=2)
    d.text((24, 34), 'VISION OK 12345', fill='black')
    import io
    bio = io.BytesIO()
    img.save(bio, format='PNG')
    return bio.getvalue()
