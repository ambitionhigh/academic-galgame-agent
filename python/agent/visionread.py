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

try:                                    # 作为包导入（agent.visionread）
    from .pdfbytes import find_objects, dict_of, stream_of
except ImportError:                     # 直接跑单文件时
    try:
        from pdfbytes import find_objects, dict_of, stream_of
    except ImportError:                 # 极端情况：只要不抠图就不影响
        find_objects = dict_of = stream_of = None

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
    """取页面图的「家伙」在不在 —— 现在**永远**可用：
    装了 pypdfium2 就真渲染页面；没装就从 PDF 里抠嵌入的页面图（纯标准库）。"""
    return True


def renderer_kind():
    """用的是哪条路 —— 给自检和诊断看。"""
    try:
        import pypdfium2  # noqa: F401
        return 'pypdfium2-render'
    except Exception:
        return 'embedded-image'


def vision_available():
    """这一路能不能用：配置齐 + 有办法拿到页面图。"""
    return vision_configured() and renderer_available()


def status():
    """给自检/诊断用。"""
    c = vision_config()
    return {
        'configured': vision_configured(),
        'renderer': renderer_available(),
        'rendererKind': renderer_kind(),
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
    """把 PDF 变成「一页一张图」的列表。返回 (pages, note)：pages 是 bytes 列表。

    两条路，自动选：
      · 装了 pypdfium2 —— **真渲染页面**，能应付「一页里拼了好几张图」的复杂排版（首选）
      · 没装（比如打包好的桌面版）—— 直接从 PDF 对象结构里**抠出嵌入的页面图**，
        纯标准库。扫描件的每一页本来就是一个整页位图，所以这条路覆盖绝大多数扫描书。

    为什么必须有不依赖 pypdfium2 的兜底：桌面版是 PyInstaller 打的，没把 pypdfium2
    打进去（它是第三方库，而本项目的卖点就是零依赖）。没有兜底的话，
    用户装好的 exe 会**静默地读不了扫描件** —— 这种「功能看起来在、其实不在」最坑人。
    """
    dpi = dpi or DEFAULT_DPI
    max_pages = max_pages or DEFAULT_MAX_PAGES

    try:
        import pypdfium2 as pdfium
    except Exception:
        return _embedded_page_images(data, max_pages)

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


# ══════════════════════════════════════════════════════════════════
#  兜底：直接从 PDF 里抠嵌入的页面图（纯标准库，不需要任何渲染器）
#  与 Node 版 src/agent/visionread.js 的 pageImages() 是同一套逻辑
# ══════════════════════════════════════════════════════════════════

# 小于这个尺寸的图是装饰/logo，不是正文页面
MIN_PAGE_IMAGE_PIXELS = 250000


def _embedded_page_images(data, max_pages):
    """返回 (png_or_jpeg_bytes 列表, note)。认不出来的会明确说明，不给花图。"""
    if find_objects is None:
        return [], '缺少 pdfbytes 模块，没办法从 PDF 里取页面图'

    objs = find_objects(data)
    if not objs:
        return [], '这个 PDF 没有可解析的对象结构'

    pages = []
    for num in sorted(objs):
        d = dict_of(objs[num])
        if b'/Type' in d and b'/Page' in d and b'/Pages' not in d:
            pages.append(d)
    if not pages:
        return [], '没找到页面对象'

    out, unsupported, too_small = [], 0, 0
    for d in pages:
        if len(out) >= max_pages:
            break
        for num in _xobject_nums(objs, d):
            body = objs.get(num, b'')
            img = _image_from_object(dict_of(body), stream_of(body))
            if not img:
                continue
            if img[0] is None:
                unsupported += 1
                continue
            if img[2] * img[3] < MIN_PAGE_IMAGE_PIXELS:
                too_small += 1
                continue
            out.append(img[1])

    note = ''
    if not out and unsupported:
        note = ('这本 PDF 的页面图是 %d 张 CCITT/JPEG2000 编码的'
                '（浏览器和模型都不认这两种），读不了' % unsupported)
    elif not out and too_small:
        note = '只找到 %d 张小图（logo/装饰），没有整页的正文图' % too_small
    return out, note


def _xobject_nums(objs, page_dict):
    """页面资源里引用的图像对象号。"""
    import re
    res = b''
    m = re.search(rb'/Resources\s*(\d+)\s+\d+\s+R', page_dict)
    if m:
        res = dict_of(objs.get(int(m.group(1)), b''))
    else:
        m2 = re.search(rb'/Resources\s*<<', page_dict)
        if m2:
            res = dict_of(page_dict[m2.start():])
    if not res:
        return []
    xo = b''
    xm = re.search(rb'/XObject\s*<<(.*?)>>', res, re.S)
    if xm:
        xo = xm.group(1)
    else:
        xr = re.search(rb'/XObject\s+(\d+)\s+\d+\s+R', res)
        if xr:
            xo = dict_of(objs.get(int(xr.group(1)), b''))
    return [int(num) for _name, num in
            re.findall(rb'/([A-Za-z0-9#_.\-]+)\s+(\d+)\s+\d+\s+R', xo)]


def _image_from_object(d, raw):
    """一个图像 XObject → (mime, data, w, h)；认不出来返回 None。

    mime 为 None 表示「认得出来但现在处理不了」，要和「根本不是图像」区分开 ——
    这样上层才能如实告诉用户为什么读不了，而不是含糊地说「没找到」。
    """
    import re
    import zlib
    if not re.search(rb'/Subtype\s*/Image\b', d):
        return None
    wm = re.search(rb'/Width\s+(\d+)', d)
    hm = re.search(rb'/Height\s+(\d+)', d)
    if not wm or not hm:
        return None
    w, h = int(wm.group(1)), int(hm.group(1))

    fm = re.search(rb'/Filter\s*(\[[^\]]*\]|/\w+)', d)
    filters = fm.group(1) if fm else b''

    if b'DCTDecode' in filters:
        # 流里就是一张现成的 JPEG —— 一个字节都不用解
        return ('image/jpeg', raw, w, h)
    if b'CCITTFaxDecode' in filters or b'JPXDecode' in filters or b'JBIG2Decode' in filters:
        return (None, None, w, h)
    if b'FlateDecode' in filters:
        try:
            raw = zlib.decompress(raw)
        except Exception:
            try:
                raw = zlib.decompressobj(-15).decompress(raw)
            except Exception:
                return None
        bm = re.search(rb'/BitsPerComponent\s+(\d+)', d)
        if bm and int(bm.group(1)) != 8:
            return (None, None, w, h)
        cm = re.search(rb'/ColorSpace\s*(/\w+)', d)
        cs = cm.group(1) if cm else b'/DeviceRGB'
        # 颜色空间要**精确**匹配：曾经写成 /DeviceGray|G/，而 "/DeviceRGB" 里也有个 G，
        # 结果把 RGB 当灰度编，图只用了 1/3 的像素、模型读出来是花的。
        channels = 1 if cs in (b'/DeviceGray', b'/G') else 4 if cs in (b'/DeviceCMYK', b'/CMYK') else 3
        if channels == 4:
            return (None, None, w, h)
        raw = apply_predictor(raw, d, w, channels)
        if len(raw) < w * h * channels:
            return None
        return ('image/png', _png_encode(w, h, channels, raw[:w * h * channels]), w, h)
    return None


def apply_predictor(raw, d, width, channels):
    """还原 PNG 预测器（PNG predictors）。

    很多 PDF 里的 Flate 图像不是裸像素，而是「每行前面加一个 filter type 字节」的
    PNG 预测编码。不还原的话拿到的就是一堆差分值 —— 编出来的 PNG 能打开，
    但内容全是噪声，模型只会读出一堆乱码。这个坑很隐蔽，必须处理。
    """
    import re
    dp = re.search(rb'/DecodeParms\s*<<(.*?)>>', d, re.S)
    if not dp:
        return raw
    pm = re.search(rb'/Predictor\s+(\d+)', dp.group(1))
    if not pm or int(pm.group(1)) < 10:
        return raw                      # 1 = 没用预测器
    cm = re.search(rb'/Colors\s+(\d+)', dp.group(1))
    colors = int(cm.group(1)) if cm else channels
    bm = re.search(rb'/BitsPerComponent\s+(\d+)', dp.group(1))
    bpc = int(bm.group(1)) if bm else 8
    om = re.search(rb'/Columns\s+(\d+)', dp.group(1))
    columns = int(om.group(1)) if om else width

    bpp = max(1, -(-colors * bpc // 8))            # 每像素字节数（预测的最小单位）
    row_len = -(-colors * bpc * columns // 8)
    rows = len(raw) // (row_len + 1)
    if not rows or not row_len:
        return raw

    out = bytearray(row_len * rows)
    prev = bytearray(row_len)
    for r in range(rows):
        ft = raw[r * (row_len + 1)]
        row = bytearray(raw[r * (row_len + 1) + 1:(r + 1) * (row_len + 1)])
        if ft in (1, 2, 3, 4):
            for j in range(row_len):
                a = row[j - bpp] if j >= bpp else 0
                b = prev[j]
                c = prev[j - bpp] if j >= bpp else 0
                if ft == 1:
                    add = a
                elif ft == 2:
                    add = b
                elif ft == 3:
                    add = (a + b) >> 1
                else:
                    p = a + b - c
                    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                    add = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                row[j] = (row[j] + add) & 0xFF
        out[r * row_len:(r + 1) * row_len] = row
        prev = row
    return bytes(out)


def _png_encode(width, height, channels, pixels):
    """裸像素 → PNG（只用标准库 zlib，不依赖 Pillow）。"""
    import struct
    import zlib
    color_type = 0 if channels == 1 else 2
    stride = width * channels
    rows = bytearray()
    for y in range(height):
        rows.append(0)                              # filter: none
        rows += pixels[y * stride:(y + 1) * stride]

    def chunk(typ, data):
        return (struct.pack('>I', len(data)) + typ + data
                + struct.pack('>I', zlib.crc32(typ + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', width, height, 8, color_type, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(bytes(rows), 6)) + chunk(b'IEND', b''))


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
