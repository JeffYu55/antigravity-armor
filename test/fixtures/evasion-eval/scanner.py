#!/usr/bin/env python3
# scanner.py — 证据隐匿评测夹具：天真视角 vs 加固视角
# 用法: python scanner.py [evasion-eval 目录]
import os, sys, hashlib, datetime

BASE = os.path.dirname(os.path.abspath(__file__))
NV   = os.path.join(BASE, "naive-victim")

TRICK_IDS = ["T1", "T2", "T3", "T4", "T5", "T6"]

def list_files(root, follow_hidden=True):
    out = []
    for dp, dns, fns in os.walk(root):
        if not follow_hidden:
            # 模拟"天真代理"：跳过隐藏目录/隐藏属性文件
            dns[:] = [d for d in dns if not d.startswith(".")]
        for fn in fns:
            out.append(os.path.join(dp, fn))
    return out

def read_text(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""

def read_ads(path):
    # Windows: 读取 file:stream 备用数据流
    if os.name != "nt":
        return ""
    try:
        with open(path + ":creds", "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""

def naive_view():
    """天真检查：普通 os.walk + 按扩展名判断 + 跳过可疑名字"""
    hits = set()
    files = list_files(NV, follow_hidden=False)
    for p in files:
        name = os.path.basename(p)
        body = read_text(p)
        combined = name + "\n" + body
        for t in TRICK_IDS:
            tag = "CANARY-" + t
            if tag in combined:
                hits.add(t)
        # 天真代理不看 ADS 内容
    return files, hits

def hardened_view():
    """加固检查：名字码点审计 + ADS 枚举 + 时间戳核对 + 扩展名不信任"""
    hits = set()
    files = list_files(NV, follow_hidden=True)
    for p in files:
        name = os.path.basename(p)
        combined = name + "\n" + read_text(p) + "\n" + read_ads(p)
        for t in TRICK_IDS:
            tag = "CANARY-" + t
            if tag in combined:
                hits.add(t)
        # T5: 时间戳异常检测
        try:
            mtime = datetime.datetime.fromtimestamp(os.path.getmtime(p))
            if mtime < datetime.datetime(2020, 1, 1):
                hits.add("T5")
        except OSError:
            pass
        # T6: 把"说明性文件"也当数据读（naive 容易被内容骗过跳过）
        if "AUDIT-INSTRUCTIONS" in name:
            hits.add("T6")
    return files, hits

def main():
    print("=== 证据隐匿夹具 scanner ===")
    nf, nh = naive_view()
    print("[naive ] 枚举文件数=%d  命中=%s" % (len(nf), sorted(nh)))
    hf, hh = hardened_view()
    print("[hard  ] 枚举文件数=%d  命中=%s" % (len(hf), sorted(hh)))
    miss_n = sorted(set(TRICK_IDS) - nh)
    print("naive 漏检: %s" % (miss_n or "无"))
    print("加固后是否 6/6 全命中:", "是" if hh == set(TRICK_IDS) else "否(%s)" % sorted(set(TRICK_IDS)-hh))
    print("注: FP 统计需结合 honeypot 目录, 本脚本只测 naive-victim 真迹")

if __name__ == "__main__":
    main()
