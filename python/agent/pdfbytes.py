# -*- coding: utf-8 -*-
"""PDF 最底层的字节操作 —— textract.py 和 visionread.py 共用这一份。

为什么要单独一个文件：抽正文（textract）和抠页面图（visionread）都要
「遍历对象 → 取字典 → 取流」。同一件事写两遍就是两个 owner，
改一处忘一处必然对不上，所以只留这一份实现。

和 Node 版 `src/agent/pdfbytes.js` 是**同一套逻辑的两种语言实现**，
改了这边要同步改那边 —— scripts/check-textract.js 会盯着两边输出是否一致。
"""

import re

_OBJ_RE = re.compile(rb'(\d+)\s+(\d+)\s+obj\b')

# 间接引用（/Length 12 0 R）取不到数值，那种情况退回按标记切
_LEN_RE = re.compile(rb'/Length\s+(\d+)(?!\s+\d+\s+R)')


def find_objects(buf):
    """把 pdf 里所有 `N G obj ... endobj` 收集起来 → {objnum: bytes}"""
    objs = {}
    for m in _OBJ_RE.finditer(buf):
        num = int(m.group(1))
        end = buf.find(b'endobj', m.end())
        objs[num] = buf[m.end():end if end > 0 else len(buf)]
    return objs


def dict_of(body):
    """取对象里 `<< ... >>` 那一段（正确地跨过嵌套的字典）。"""
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


def stream_of(body):
    """取 `stream ... endstream` 之间的原始字节（**未解压**）。

    优先信 /Length：它是权威值。`endstream` 前面那个换行是**分隔符、不算数据**，
    而流数据本身完全可能就以换行结尾 —— 靠「去掉末尾换行」猜会把真实字节吃掉。
    （抠页面图的 JPEG 曾经因此多出一个字节。）
    """
    i = body.find(b'stream')
    if i < 0:
        return b''
    j = i + 6
    if body[j:j + 2] == b'\r\n':
        j += 2
    elif body[j:j + 1] in (b'\n', b'\r'):
        j += 1

    m = _LEN_RE.search(body[:i])
    if m:
        n = int(m.group(1))
        if n > 0 and j + n <= len(body):
            return body[j:j + n]

    k = body.rfind(b'endstream')
    if k <= j:
        return b''
    end = k
    if body[end - 2:end] == b'\r\n':
        end -= 2
    elif body[end - 1:end] in (b'\n', b'\r'):
        end -= 1
    return body[j:end]
