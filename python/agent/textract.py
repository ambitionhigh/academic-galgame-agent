# -*- coding: utf-8 -*-
"""从 ima 知识库下载下来的**原始文件**里抽出正文（纯标准库，零依赖）。

为什么需要这个：
    ima 的 get_media_info 给的是「原始文件」的下载地址 —— 你往知识库里放的是
    PDF / EPUB 书，拿到手就是几十 MB 的二进制。直接当文本读只会得到
    `%PDF-1.6 %äüöß...` 这种乱码。所以必须自己抽正文。

支持的格式：
    · EPUB  —— 本质是 zip + XHTML，稳
    · PDF   —— 解析内容流 + ToUnicode CMap，支持中文字体（Type0/Identity-H）
    · 纯文本（.md/.txt）—— 原样返回

不支持 / 抽不出来时返回空字符串，由上层如实告诉用户「这本书是扫描件，读不了」，
而不是把乱码喂给模型。
"""

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zlib
import zipfile

# 单次解析的输入上限：再大就不划算（一本 200MB 的扫描书解析出来也是空的）
MAX_INPUT_BYTES = 150 * 1024 * 1024

# 抽到的字少于这个数，就当作「没抽到」：多半是扫描版/图片版/需要登录的网页笔记。
# 宁可如实说读不了，也不要把目录或乱码喂给模型。
MIN_USEFUL_CHARS = 400


# ══════════════════════════════════════════════════════════════════
#  MinerU（可选）：扫描版 / 复杂版面的救援路径
# ══════════════════════════════════════════════════════════════════
#
# MinerU（github.com/opendatalab/MinerU）带 OCR 与版面分析，能读内置解析器
# 啃不动的扫描版 PDF、表格、公式。但它要装几 GB 的模型、跑得也慢，
# 所以这里做成**可选**：
#
#   · 没装 → 完全不参与，行为与以前一模一样（项目保持零依赖）
#   · 装了 → auto 模式下只在「内置解析器读不出来」时才动用它当救援
#            （普通文字版 PDF 走内置的，快得多）
#            always 模式下优先用它（质量更好，但慢）
#
# 绝不使用 --remote：那会把用户的资料上传到 MinerU 的服务器。
# 隐私边界由使用者自己决定，我们不替他们决定。

MINERU_MODE = (os.environ.get('GALGAME_MINERU') or 'auto').strip().lower()
MINERU_TIMEOUT = int(os.environ.get('GALGAME_MINERU_TIMEOUT') or 600)
_mineru_cmd = None          # 探测结果缓存：'' 表示没有


def mineru_command():
    """探测可用的 MinerU CLI；没装返回 ''（结果会缓存）。

    认两种入口：`mineru`（新版，agent 向）与 `mineru-kit`（无状态转换）。
    也可以用 MINERU_CMD 显式指定路径。
    """
    global _mineru_cmd
    if _mineru_cmd is not None:
        return _mineru_cmd
    if MINERU_MODE in ('0', 'off', 'false', 'no', 'none'):
        _mineru_cmd = ''
        return ''
    explicit = os.environ.get('MINERU_CMD')
    if explicit:
        found = shutil.which(explicit) or (explicit if os.path.isfile(explicit) else '')
        if found:
            _mineru_cmd = found
            return found
    for name in ('mineru', 'mineru-kit'):
        found = shutil.which(name)
        if found:
            _mineru_cmd = found
            return found
    _mineru_cmd = ''
    return ''


def mineru_available():
    return bool(mineru_command())


def _run(cmd, timeout):
    """跑子进程，返回 (ok, stdout, stderr)。不抛异常。

    ⚠️ 必须强制子进程用 UTF-8 输出。MinerU 是 Python 工具，在中文 Windows 上
    它的 stdout 默认跟随控制台代码页（GBK）—— 那样我们按 UTF-8 读回来就是乱码。
    （实测过：同一份 JSON，GBK 输出会让正文长度从 1451 变成 2175 的乱码。）
    """
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONUTF8'] = '1'
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return False, '', '超时（%ss）' % timeout
    except Exception as e:
        return False, '', str(e)
    out = (p.stdout or b'').decode('utf-8', 'replace')
    err = (p.stderr or b'').decode('utf-8', 'replace')
    return p.returncode == 0, out, err


def mineru_text(data, filename='', timeout=None):
    """用 MinerU 抽正文。返回 (text, note)。

    note 非空表示没成功，里面是原因 —— 交给上层如实告诉用户，而不是静默当作没抽到。
    """
    exe = mineru_command()
    if not exe:
        return '', 'MinerU 未安装'
    timeout = timeout or MINERU_TIMEOUT

    work = tempfile.mkdtemp(prefix='galgame-mineru-')
    try:
        name = os.path.basename(filename) or 'document.pdf'
        src = os.path.join(work, name)
        with open(src, 'wb') as f:
            f.write(data)

        # ① 新版 CLI：mineru parse <file> --json（返回结构里有 content.content）
        ok, out, err = _run([exe, 'parse', src, '--pages', 'all', '--json'], timeout)
        if ok:
            text = _mineru_extract_json(out)
            if text.strip():
                return text, ''
            err = err or '返回里没有正文'

        # ② 兜底：无状态转换 mineru-kit parse <file> -o <out.md>
        kit = os.environ.get('MINERU_KIT_CMD') or shutil.which('mineru-kit')
        if kit:
            out_md = os.path.join(work, 'out.md')
            ok2, _out2, err2 = _run([kit, 'parse', src, '-o', out_md], timeout)
            if ok2 and os.path.isfile(out_md):
                try:
                    with open(out_md, 'r', encoding='utf-8', errors='replace') as f:
                        text = f.read()
                    if text.strip():
                        return text, ''
                except OSError as e:
                    err2 = str(e)
            err = err2 or err
        return '', 'MinerU 没抽出正文（%s）' % ((err or '未知原因').strip()[:200])
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _mineru_extract_json(stdout):
    """从 mineru 的 --json 输出里取正文。

    输出可能夹着日志行，所以先整体试 JSON，不行再从每一行/每个 `{` 起试。
    """
    def dig(obj):
        if not isinstance(obj, dict):
            return ''
        c = obj.get('content')
        if isinstance(c, dict):
            for k in ('content', 'markdown', 'text'):
                v = c.get(k)
                if isinstance(v, str) and v.strip():
                    return v
        if isinstance(c, str) and c.strip():
            return c
        for k in ('markdown', 'text', 'md'):
            v = obj.get(k)
            if isinstance(v, str) and v.strip():
                return v
        return ''

    try:
        return dig(json.loads(stdout))
    except Exception:
        pass
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            got = dig(json.loads(line))
            if got:
                return got
        except Exception:
            continue
    return ''


# ══════════════════════════════════════════════════════════════════
#  对外入口
# ══════════════════════════════════════════════════════════════════

def sniff_kind(data, filename=''):
    """按内容（而不是后缀）判断类型 —— ima 给的文件头最可信。"""
    head = data[:8]
    if head.startswith(b'%PDF'):
        return 'pdf'
    if head.startswith(b'PK\x03\x04'):
        # zip：可能是 epub，也可能是 docx
        low = (filename or '').lower()
        if low.endswith('.epub'):
            return 'epub'
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                names = z.namelist()
            if 'META-INF/container.xml' in names:
                return 'epub'
            if 'word/document.xml' in names:
                return 'docx'
            return 'zip'
        except Exception:
            return 'zip'
    # 纯文本：能干净地按 UTF-8 解出来就算文本
    try:
        data[:4096].decode('utf-8')
        return 'text'
    except UnicodeDecodeError:
        return 'binary'


def extract_text(data, filename=''):
    """把原始文件抽成纯文本；抽不出来返回 ''。

    返回 (text, kind, note)：note 用于向用户解释「为什么这本书读不了」。
    """
    if not data:
        return '', 'empty', '文件是空的'
    if len(data) > MAX_INPUT_BYTES:
        return '', 'toolarge', '文件超过 %d MB，跳过解析' % (MAX_INPUT_BYTES // 1024 // 1024)

    kind = sniff_kind(data, filename)
    text, note = '', ''

    if kind == 'text':
        head = data[:400].lstrip().lower()
        if head.startswith(b'<!doctype html') or head.startswith(b'<html') or b'<body' in data[:4000].lower():
            text = _html_to_text(data.decode('utf-8', 'replace'))
            kind = 'html'
            note = '这是一个网页笔记，正文要登录才能看到，抽不到'
        else:
            text = data.decode('utf-8', 'replace')
    elif kind == 'epub':
        text = _epub_text(data)
        # 文字少 + 图片多 = 图片版书（扫描的），抽出来的多半只是封面和目录
        if len(text.strip()) < 20000:
            nb = _image_book_note(data, '这本 EPUB')
            if nb:
                text, note = '', nb
    elif kind == 'pdf':
        # MinerU 是可选的重武器：always 模式先上它；auto 模式先走内置解析器
        # （普通文字版 PDF 内置的又快又够用），读不出来才请它来救援扫描件。
        if mineru_available() and MINERU_MODE in ('always', '1', 'on', 'true', 'yes'):
            mt, _mnote = mineru_text(data, filename)
            if mt.strip():
                return mt, 'pdf+mineru', ''

        text, _scanned = _pdf_text(data)
        if not text.strip() and mineru_available():
            mt, mnote = mineru_text(data, filename)
            if mt.strip():
                return mt, 'pdf+mineru', ''
            return '', 'pdf-scanned', (
                '这本 PDF 内置解析器读不出来（多半是扫描件），MinerU 也没成功：%s' % mnote)
        if not text.strip():
            return '', 'pdf-scanned', (
                '这本 PDF 抽不到文字，多半是**扫描件**（整页都是图片），不是文字版。'
                '装上 MinerU（带 OCR）就能读这类文件，见 README 的「扫描版 PDF」一节')
    elif kind == 'docx':
        text = _docx_text(data)
    else:
        return '', kind, '不认识的格式（%s），没法抽正文' % kind

    if not text.strip():
        return '', kind, note or '没抽到文字'
    if len(text.strip()) < MIN_USEFUL_CHARS:
        return '', kind + '-tiny', (note or '只抽到 %d 个字，基本是目录或图片版，读不了正文'
                                   % len(text.strip()))
    return text, kind, ''


def _image_book_note(data, what):
    """文字少是不是因为整本都是图片（扫描版）？是就返回说明，不是返回 ''。"""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            n_img = sum(1 for n in z.namelist()
                        if n.lower().endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp')))
    except Exception:
        n_img = 0
    if n_img >= 10:
        return '%s 是**图片版**（正文在 %d 张图片里，没有可抽取的文字）' % (what, n_img)
    return ''


# ══════════════════════════════════════════════════════════════════
#  EPUB
# ══════════════════════════════════════════════════════════════════

_TAG_RE = re.compile(r'<[^>]+>')
_SCRIPT_RE = re.compile(r'<(script|style)[^>]*>.*?</\1>', re.S | re.I)


def _html_to_text(html):
    s = _SCRIPT_RE.sub(' ', html)
    s = re.sub(r'<br\s*/?>', '\n', s, flags=re.I)
    s = re.sub(r'</(p|div|h[1-6]|li|tr)>', '\n', s, flags=re.I)
    s = _TAG_RE.sub('', s)
    s = (s.replace('&nbsp;', ' ').replace('&lt;', '<').replace('&gt;', '>')
          .replace('&quot;', '"').replace('&#39;', "'").replace('&amp;', '&'))
    s = re.sub(r'&#x([0-9a-fA-F]+);', lambda m: chr(int(m.group(1), 16)), s)
    s = re.sub(r'&#(\d+);', lambda m: chr(int(m.group(1))), s)
    s = re.sub(r'[ \t\u00a0]+', ' ', s)
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s.strip()


def _epub_text(data):
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except Exception:
        return ''
    names = z.namelist()

    # 按 OPF 的 spine 顺序读，读不到就退化成正序读所有 xhtml/html
    order = []
    try:
        container = z.read('META-INF/container.xml').decode('utf-8', 'replace')
        m = re.search(r'full-path="([^"]+)"', container)
        if m:
            opf_path = m.group(1)
            opf = z.read(opf_path).decode('utf-8', 'replace')
            base = opf_path.rsplit('/', 1)[0] if '/' in opf_path else ''
            manifest = dict(re.findall(r'<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"', opf))
            if not manifest:
                manifest = dict(re.findall(r'<item\b[^>]*\bhref="([^"]+)"[^>]*\bid="([^"]+)"', opf))
                manifest = {v: k for k, v in manifest.items()}
            for idref in re.findall(r'<itemref\b[^>]*\bidref="([^"]+)"', opf):
                href = manifest.get(idref)
                if href:
                    order.append((base + '/' + href) if base else href)
    except Exception:
        pass

    if not order:
        order = [n for n in names if n.lower().endswith(('.xhtml', '.html', '.htm'))]

    parts = []
    used = set()
    for path in order:
        try:
            raw = z.read(path)
        except KeyError:
            continue
        used.add(path)
        parts.append(_html_to_text(raw.decode('utf-8', 'replace')))

    text = '\n\n'.join(p for p in parts if p)

    # 有些 EPUB 的 spine 只挂了封面和目录，正文在别的文件里。
    # 抽到的字太少时，把所有 xhtml/html 都补读一遍。
    if len(text) < 20000:
        extra = []
        for name in names:
            if name in used or not name.lower().endswith(('.xhtml', '.html', '.htm')):
                continue
            try:
                extra.append(_html_to_text(z.read(name).decode('utf-8', 'replace')))
            except Exception:
                continue
        merged = text + '\n\n' + '\n\n'.join(e for e in extra if e)
        if len(merged) > len(text):
            text = merged
    return text


# ══════════════════════════════════════════════════════════════════
#  DOCX（顺带，ima 里也可能有 Word）
# ══════════════════════════════════════════════════════════════════

def _docx_text(data):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml = z.read('word/document.xml').decode('utf-8', 'replace')
    except Exception:
        return ''
    xml = re.sub(r'</w:p>', '\n', xml)
    xml = re.sub(r'<w:tab[^>]*/>', '\t', xml)
    return _html_to_text(xml)


# ══════════════════════════════════════════════════════════════════
#  PDF
# ══════════════════════════════════════════════════════════════════

_OBJ_RE = re.compile(rb'(\d+)\s+(\d+)\s+obj\b')


def _find_objects(buf):
    """把 pdf 里所有 `N G obj ... endobj` 收集起来 → {objnum: bytes}"""
    objs = {}
    for m in _OBJ_RE.finditer(buf):
        num = int(m.group(1))
        end = buf.find(b'endobj', m.end())
        objs[num] = buf[m.end():end if end > 0 else len(buf)]
    return objs


def _dict_of(body):
    """取对象里 `<< ... >>` 那一段（粗略配对，够用）。"""
    start = body.find(b'<<')
    if start < 0:
        return b''
    depth = 0
    i = start
    while i < len(body) - 1:
        if body[i:i + 2] == b'<<':
            depth += 1
            i += 2
            continue
        if body[i:i + 2] == b'>>':
            depth -= 1
            i += 2
            if depth == 0:
                return body[start:i]
            continue
        i += 1
    return body[start:]


def _stream_of(body):
    """取 `stream ... endstream` 之间的原始字节。"""
    i = body.find(b'stream')
    if i < 0:
        return b''
    j = i + 6
    if body[j:j + 2] == b'\r\n':
        j += 2
    elif body[j:j + 1] in (b'\n', b'\r'):
        j += 1
    k = body.rfind(b'endstream')
    return body[j:k] if k > j else b''


def _decode_stream(dict_bytes, raw):
    """按 /Filter 解压。支持 FlateDecode 与 ASCIIHexDecode / ASCII85Decode。"""
    filters = re.findall(rb'/Filter\s*(\[[^\]]*\]|/\w+)', dict_bytes)
    names = []
    for f in filters:
        names += re.findall(rb'/(\w+)', f)
    data = raw
    for name in names:
        try:
            if name in (b'FlateDecode', b'Fl'):
                data = zlib.decompress(data)
            elif name in (b'ASCIIHexDecode', b'AHx'):
                hexs = re.sub(rb'[^0-9A-Fa-f]', b'', data.split(b'>')[0])
                if len(hexs) % 2:
                    hexs += b'0'
                data = bytes.fromhex(hexs.decode('ascii'))
            elif name in (b'ASCII85Decode', b'A85'):
                data = _a85(data)
        except Exception:
            return b''
    return data


def _a85(data):
    import base64
    s = data.strip()
    if s.startswith(b'<~'):
        s = s[2:]
    s = s.split(b'~>')[0]
    return base64.a85decode(s, adobe=False)


def _resolve(objs, token):
    """把 `12 0 R` 解析成对应对象的字节。"""
    m = re.match(rb'\s*(\d+)\s+\d+\s+R', token or b'')
    if not m:
        return b''
    return objs.get(int(m.group(1)), b'')


def _parse_tounicode(cmap_bytes):
    """解析 ToUnicode CMap → {字符码: unicode 字符串}，并推断每个码占几个字节。"""
    table = {}
    width = 1
    text = cmap_bytes.decode('latin-1', 'replace')

    for block in re.findall(r'beginbfchar(.*?)endbfchar', text, re.S):
        for src, dst in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', block):
            if len(src) >= 4:
                width = 2
            table[int(src, 16)] = _hex_to_str(dst)

    for block in re.findall(r'beginbfrange(.*?)endbfrange', text, re.S):
        for lo, hi, dst in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', block):
            if len(lo) >= 4:
                width = 2
            a, b = int(lo, 16), int(hi, 16)
            base = int(dst, 16)
            if b - a > 65535:
                continue
            for i in range(b - a + 1):
                table[a + i] = _code_to_str(base + i, len(dst))
        for lo, hi, arr in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[(.*?)\]', block, re.S):
            if len(lo) >= 4:
                width = 2
            a = int(lo, 16)
            for i, d in enumerate(re.findall(r'<([0-9A-Fa-f]+)>', arr)):
                table[a + i] = _hex_to_str(d)
    return table, width


def _hex_to_str(h):
    if len(h) % 4 == 0:
        try:
            return bytes.fromhex(h).decode('utf-16-be')
        except Exception:
            pass
    try:
        return chr(int(h, 16))
    except Exception:
        return ''


def _code_to_str(code, hexlen):
    if hexlen >= 4:
        try:
            return chr(code)
        except Exception:
            return ''
    return chr(code) if code < 0x110000 else ''


def _escape_string(raw):
    """把 PDF 字符串字面量里的转义还原成字节。"""
    out = bytearray()
    i = 0
    while i < len(raw):
        c = raw[i]
        if c == 0x5c and i + 1 < len(raw):     # 反斜杠
            n = raw[i + 1]
            simple = {0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12,
                      0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c}
            if n in simple:
                out.append(simple[n]); i += 2; continue
            if 0x30 <= n <= 0x37:              # 八进制
                j = i + 1
                oct_digits = b''
                while j < len(raw) and len(oct_digits) < 3 and 0x30 <= raw[j] <= 0x37:
                    oct_digits += bytes([raw[j]]); j += 1
                out.append(int(oct_digits, 8) & 0xFF); i = j; continue
            if n in (10, 13):                  # 续行
                i += 2; continue
            out.append(n); i += 2; continue
        out.append(c); i += 1
    return bytes(out)


def _pdf_text(data):
    """返回 (正文, 是否疑似扫描件)。"""
    objs = _find_objects(data)
    if not objs:
        return '', True

    # ── 收集字体：名字 -> {map, width}。按页的 /Resources 建立局部映射。
    font_cache = {}

    def font_for(font_obj_num):
        if font_obj_num in font_cache:
            return font_cache[font_obj_num]
        body = objs.get(font_obj_num, b'')
        d = _dict_of(body)
        info = {'map': {}, 'width': 1}
        m = re.search(rb'/ToUnicode\s+(\d+)\s+\d+\s+R', d)
        if m:
            tu_body = objs.get(int(m.group(1)), b'')
            cmap_raw = _decode_stream(_dict_of(tu_body), _stream_of(tu_body))
            if cmap_raw:
                info['map'], info['width'] = _parse_tounicode(cmap_raw)
        if not info['map'] and re.search(rb'/Subtype\s*/Type0', d):
            info['width'] = 2               # Identity-H 但没有 CMap：只能按 2 字节切
        font_cache[font_obj_num] = info
        return info

    def page_fonts(res_dict):
        """{/F1: fontinfo, ...}"""
        out = {}
        fm = re.search(rb'/Font\s*<<(.*?)>>', res_dict, re.S)
        font_block = b''
        if fm:
            font_block = fm.group(1)
        else:
            fr = re.search(rb'/Font\s+(\d+)\s+\d+\s+R', res_dict)
            if fr:
                font_block = _dict_of(objs.get(int(fr.group(1)), b''))
        for name, num in re.findall(rb'/([A-Za-z0-9#_.\-]+)\s+(\d+)\s+\d+\s+R', font_block):
            out[name] = font_for(int(num))
        return out

    # ── 遍历页面
    pages = []
    for num, body in objs.items():
        d = _dict_of(body)
        if re.search(rb'/Type\s*/Page\b', d) and not re.search(rb'/Type\s*/Pages\b', d):
            pages.append((num, d, body))
    # 页面顺序：优先按对象号（大多数 PDF 恰好一致）
    pages.sort(key=lambda x: x[0])

    chunks = []
    for _num, d, body in pages:
        res = b''
        rm = re.search(rb'/Resources\s*(\d+)\s+\d+\s+R', d)
        if rm:
            res = _dict_of(objs.get(int(rm.group(1)), b''))
        else:
            rm2 = re.search(rb'/Resources\s*<<', d)
            if rm2:
                res = _dict_of(d[rm2.start():])
        fonts = page_fonts(res)
        text = _content_to_text(_page_content(objs, d), fonts)
        if text.strip():
            chunks.append(text)

    full = '\n\n'.join(chunks)
    return full, (not full.strip())


def _page_content(objs, page_dict):
    """把一页的 /Contents（可能是数组）拼起来。"""
    out = []
    m = re.search(rb'/Contents\s*(\d+)\s+\d+\s+R', page_dict)
    if m:
        out.append(objs.get(int(m.group(1)), b''))
    else:
        arr = re.search(rb'/Contents\s*\[(.*?)\]', page_dict, re.S)
        if arr:
            for num in re.findall(rb'(\d+)\s+\d+\s+R', arr.group(1)):
                out.append(objs.get(int(num), b''))
    data = b''
    for chunk in out:
        data += _decode_stream(_dict_of(chunk), _stream_of(chunk)) + b'\n'
    return data


# PDF 内容流的 token：
#   str  = 字面字符串 (...)      hex = 十六进制字符串 <...>
#   name = 名字对象 /Name        num = 数字
#   arr  = 数组括号 [ ]          op  = 操作符（Tj / TJ / Tf / Td ...）
_TOKEN_RE = re.compile(
    rb'(?P<str>\((?:\\.|[^\\()])*\))'
    rb'|(?P<hex><[0-9A-Fa-f\s]*>)'
    rb'|(?P<name>/[^\s/\[\]<>(){}]+)'
    rb'|(?P<num>[-+]?\d*\.?\d+)'
    rb'|(?P<arr>[\[\]])'
    rb'|(?P<op>[A-Za-z\'"*][A-Za-z0-9\'"*]*)',
    re.X | re.S)


def _content_to_text(content, fonts):
    """遍历内容流，按当前字体解码文字。

    换行不能靠「遇到 Td 就换行」—— 很多 PDF 是**逐字**定位的，那样会变成一个汉字一行。
    正确做法是跟踪文本的 Y 坐标，只有 Y 真的变了才换行。
    """
    if not content:
        return ''
    cur = {'map': {}, 'width': 1}
    out = []
    pending = []
    state = {'y': None, 'last_y': None, 'leading': 0.0}

    def decode(raw_bytes):
        m = cur['map']
        w = cur['width']
        if not m:
            if w == 2:
                try:
                    return raw_bytes.decode('utf-16-be', 'replace')
                except Exception:
                    return ''
            return raw_bytes.decode('latin-1', 'replace')
        if w == 2:
            return ''.join(m.get((raw_bytes[i] << 8) | raw_bytes[i + 1], '')
                           for i in range(0, len(raw_bytes) - 1, 2))
        return ''.join(m.get(b, '') for b in raw_bytes)

    def flush(newline=False):
        s = ''.join(pending)
        pending.clear()
        if s:
            out.append(s)
        if newline and out and not out[-1].endswith('\n'):
            out.append('\n')

    def see_y(y):
        """Y 变了就断行（阈值 2.0 足以忽略同一行的微小抖动）"""
        if state['y'] is None:
            state['y'] = y
        elif abs(y - state['y']) > 2.0:
            flush(newline=True)
            state['y'] = y

    nums = []

    for m in _TOKEN_RE.finditer(content):
        kind = m.lastgroup
        tok = m.group()

        if kind == 'num':
            try:
                nums.append(float(tok))
            except ValueError:
                nums.append(0.0)
            if len(nums) > 8:
                nums = nums[-8:]
            continue

        if kind == 'name':
            name = tok[1:]
            if name in fonts:
                cur = fonts[name]
            nums = []
            continue

        if kind == 'str':
            pending.append(decode(_escape_string(tok[1:-1])))
            nums = []
            continue

        if kind == 'hex':
            h = re.sub(rb'\s', b'', tok[1:-1])
            if len(h) % 2:
                h += b'0'
            try:
                pending.append(decode(bytes.fromhex(h.decode('ascii'))))
            except Exception:
                pass
            nums = []
            continue

        if kind == 'op':
            op = tok
            if op in (b'Tj', b"'", b'"'):
                if op in (b"'", b'"'):
                    flush(newline=True)
                flush()
            elif op == b'TJ':
                # TJ 数组里夹的数字是字距；明显负值往往代表一个空格
                flush()
            elif op == b'Td' and len(nums) >= 2:
                state['y'] = (state['y'] or 0.0) + nums[-1]
                see_y(state['y'])
            elif op == b'TD' and len(nums) >= 2:
                state['leading'] = -nums[-1]
                state['y'] = (state['y'] or 0.0) + nums[-1]
                see_y(state['y'])
            elif op == b'Tm' and len(nums) >= 6:
                state['y'] = nums[-1]
                see_y(state['y'])
            elif op == b'T*':
                state['y'] = (state['y'] or 0.0) - state['leading']
                see_y(state['y'])
            elif op == b'ET':
                flush(newline=True)
            nums = []
            continue

    flush()
    text = ''.join(out)
    text = text.replace('\x00', '')
    text = re.sub(r'[ \t]{2,}', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()
