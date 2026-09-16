#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Clash Verge 节点多维客观测速引擎

import os
import sys
import re
import json
import time
import socket
import http.client
import subprocess
import urllib.request
import urllib.parse
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed

# 自动扩展 macOS 终端窗口尺寸（宽 178 列，高 38 行）
sys.stdout.write("\x1b[8;38;178t")
sys.stdout.flush()

# ANSI 终端颜色
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

CONFIG_PATH = os.path.expanduser('~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/config.yaml')
SOCK_PATH = '/tmp/verge/verge-mihomo.sock'

# 国家/地区识别规则表（按优先级匹配）
REGION_RULES = [
    ('中国香港', [r'香港', r'港', r'HK', r'HongKong', r'Hong Kong', r'HKG', r'🇭🇰']),
    ('中国台湾', [r'台湾', r'臺湾', r'台北', r'新北', r'高雄', r'TW', r'Taiwan', r'TWN', r'🇹🇼']),
    ('日本', [r'日本', r'东京', r'大阪', r'TY', r'OS', r'JP', r'Japan', r'JPN', r'Tokyo', r'Osaka', r'🇯🇵']),
    ('新加坡', [r'新加坡', r'狮城', r'SG', r'Singapore', r'SGP', r'🇸🇬']),
    ('美国', [r'美国', r'美', r'US', r'USA', r'United States', r'洛杉矶', r'硅谷', r'圣何塞', r'纽约', r'西雅图', r'芝加哥', r'凤凰城', r'达拉斯', r'波特兰', r'俄勒冈', r'🇺🇸']),
    ('韩国', [r'韩国', r'韓', r'KR', r'Korea', r'KOR', r'首尔', r'首爾', r'🇰🇷']),
    ('英国', [r'英国', r'英', r'UK', r'GB', r'GBR', r'Great Britain', r'England', r'伦敦', r'London', r'🇬🇧']),
    ('德国', [r'德国', r'德', r'DE', r'DEU', r'Germany', r'法兰克福', r'Frankfurt', r'🇩🇪']),
    ('法国', [r'法国', r'法', r'FR', r'FRA', r'France', r'巴黎', r'Paris', r'🇫🇷']),
    ('荷兰', [r'荷兰', r'荷', r'NL', r'NLD', r'Netherlands', r'阿姆斯特丹', r'Amsterdam', r'🇳🇱']),
    ('澳大利亚', [r'澳大利亚', r'澳洲', r'AU', r'AUS', r'Australia', r'悉尼', r'墨尔本', r'Sydney', r'Melbourne', r'🇦🇺']),
    ('加拿大', [r'加拿大', r'加', r'CA', r'CAN', r'Canada', r'温哥华', r'多伦多', r'Vancouver', r'Toronto', r'🇨🇦']),
    ('爱沙尼亚', [r'爱沙尼亚', r'EE', r'EST', r'Estonia', r'🇪🇪']),
    ('俄罗斯', [r'俄罗斯', r'俄', r'RU', r'RUS', r'Russia', r'莫斯科', r'Moscow', r'🇷🇺']),
    ('印度', [r'印度', r'IN', r'IND', r'India', r'孟买', r'Mumbai', r'🇮🇳']),
    ('马来西亚', [r'马来西亚', r'大马', r'MY', r'MYS', r'Malaysia', r'吉隆坡', r'Kuala Lumpur', r'🇲🇾']),
    ('泰国', [r'泰国', r'泰', r'TH', r'THA', r'Thailand', r'曼谷', r'Bangkok', r'🇹🇭']),
    ('菲律宾', [r'菲律宾', r'PH', r'PHL', r'Philippines', r'马尼拉', r'Manila', r'🇵🇭']),
    ('土耳其', [r'土耳其', r'TR', r'TUR', r'Turkey', r'伊斯坦布尔', r'Istanbul', r'🇹🇷']),
    ('阿根廷', [r'阿根廷', r'AR', r'ARG', r'Argentina', r'🇦🇷']),
    ('巴西', [r'巴西', r'BR', r'BRA', r'Brazil', r'🇧🇷']),
    ('瑞士', [r'瑞士', r'CH', r'CHE', r'Switzerland', r'苏黎世', r'🇨🇭']),
    ('瑞典', [r'瑞典', r'SE', r'SWE', r'Sweden', r'斯德哥尔摩', r'🇸🇪']),
]

def detect_region(name):
    for region, patterns in REGION_RULES:
        for p in patterns:
            if re.search(r'(?i)(^|[^\w])' + p + r'([^\w]|$)', name) or (re.search(r'[\u4e00-\u9fa5]', p) and p in name):
                return region
    m_zh = re.match(r'^([\u4e00-\u9fa5]{2,4})', name)
    if m_zh:
        return m_zh.group(1)
    return '其他地区'

def classify_nodes_by_region(nodes):
    grouped = {}
    for name, p in nodes.items():
        reg = detect_region(name)
        grouped.setdefault(reg, {})[name] = p
    sorted_regions = sorted(grouped.items(), key=lambda x: len(x[1]), reverse=True)
    return sorted_regions

def strip_ansi(s):
    return re.sub(r"\033\[[0-9;]*m", "", s)

def get_display_width(s):
    # 1. 剥离 ANSI 颜色代码
    clean = strip_ansi(s)
    # 2. 剥离零宽字符和变体选择器（如 \uFE0E, \uFE0F 等）
    clean_no_vs = re.sub(r'[\uFE00-\uFE0F\u200B-\u200D]', '', clean)
    # 3. 统计国旗 Emoji 数量（成对区域指示符号 0x1F1E6 - 0x1F1FF）
    flags = re.findall(r'[\U0001F1E6-\U0001F1FF]{2}', clean_no_vs)
    s_core = re.sub(r'[\U0001F1E6-\U0001F1FF]{2}', '', clean_no_vs)
    
    w = 0
    for ch in s_core:
        if 0x1F1E6 <= ord(ch) <= 0x1F1FF:
            w += 2
        elif unicodedata.east_asian_width(ch) in ('F', 'W'):
            w += 2
        else:
            w += 1
    # 在 macOS Terminal 等宽字体中，每个成对国旗 Emoji 屏幕实际视觉渲染占位为 1 个半角宽度
    w += len(flags) * 1
    return w

def pad_to(s, target_width, align='left'):
    w = get_display_width(s)
    if w > target_width:
        cur = ''
        clean = strip_ansi(s)
        for ch in clean:
            if get_display_width(cur + ch) > target_width - 2:
                cur += '..'
                break
            cur += ch
        w = get_display_width(cur)
        return cur + ' ' * (target_width - w)
    pad = ' ' * (target_width - w)
    if align == 'right':
        return pad + s
    elif align == 'center':
        left = pad[:len(pad)//2]
        right = pad[len(pad)//2:]
        return left + s + right
    return s + pad

def get_clash_config():
    port = 9097
    secret = ''
    mixed_port = 7897
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                content = f.read()
            m_port = re.search(r"external-controller:\s*[\d\.]+:(\d+)", content)
            if m_port:
                port = int(m_port.group(1))
            m_sec = re.search(r"secret:\s*([^\s]+)", content)
            if m_sec:
                secret = m_sec.group(1).strip("'\"")
            m_mix = re.search(r"mixed-port:\s*(\d+)", content)
            if m_mix:
                mixed_port = int(m_mix.group(1))
        except Exception:
            pass
    return port, secret, mixed_port

PORT, SECRET, MIXED_PORT = get_clash_config()

def api_request(method, path, body=None, timeout=3):
    headers = {'Authorization': f'Bearer {SECRET}', 'Content-Type': 'application/json'}
    try:
        conn = http.client.HTTPConnection('127.0.0.1', PORT, timeout=timeout)
        conn.request(method, path, body=body, headers=headers)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res.status, data
    except Exception:
        pass
    if os.path.exists(SOCK_PATH):
        try:
            conn = http.client.HTTPConnection('localhost', timeout=timeout)
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(timeout)
            sock.connect(SOCK_PATH)
            conn.sock = sock
            conn.request(method, path, body=body, headers=headers)
            res = conn.getresponse()
            data = res.read()
            conn.close()
            return res.status, data
        except Exception:
            pass
    return None, None

def get_proxies():
    status, data = api_request('GET', '/proxies')
    if status != 200 or not data:
        return {}, None
    obj = json.loads(data.decode('utf-8'))
    proxies = obj.get('proxies', {})
    cur_proxy = proxies.get('Proxy', {}).get('now') or proxies.get('GLOBAL', {}).get('now')
    ignore_types = {'Selector', 'URLTest', 'Fallback', 'Direct', 'Reject', 'Compatible', 'Pass'}
    nodes = {}
    for name, p in proxies.items():
        if p.get('type') not in ignore_types and not name.startswith('PASS') and not name.startswith('REJECT'):
            if '剩余' in name or '到期' in name or '官网' in name:
                continue
            nodes[name] = p
    return nodes, cur_proxy

def probe_node_delay(node_name, url):
    enc = urllib.parse.quote(node_name)
    path = f"/proxies/{enc}/delay?timeout=2500&url={urllib.parse.quote(url)}"
    status, data = api_request('GET', path, timeout=3)
    if status == 200 and data:
        try:
            d = json.loads(data.decode('utf-8')).get('delay')
            return d if d and d > 0 else None
        except Exception:
            return None
    return None

def test_single_node_stability(node_name, proto):
    google_url = 'https://www.google.com/generate_204'
    cf_url = 'https://cp.cloudflare.com/generate_204'
    delays = []
    lost = 0
    total = 3

    for _ in range(total):
        d1 = probe_node_delay(node_name, google_url)
        d2 = probe_node_delay(node_name, cf_url)
        valid = [d for d in (d1, d2) if d is not None]
        if valid:
            delays.append(min(valid))
        else:
            lost += 1

    loss_rate = int((lost / total) * 100)
    avg_delay = int(sum(delays) / len(delays)) if delays else 9999
    jitter = max(delays) - min(delays) if len(delays) > 1 else 0

    return {
        'name': node_name,
        'proto': proto,
        'avg_delay': avg_delay,
        'loss_rate': loss_rate,
        'jitter': jitter,
        'alive': len(delays) > 0
    }

def probe_gemini_unlock():
    try:
        out = subprocess.check_output([
            'curl', '-sL', '-m', '4', '-x', f'http://127.0.0.1:{MIXED_PORT}',
            '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            '--compressed',
            'https://gemini.google.com/app'
        ]).decode('utf-8', errors='ignore')
        
        blocked = any(kw in out for kw in [
            "isn't currently supported in your country",
            "not supported in your country",
            "is not supported in this region",
            "不支持你所在的地区"
        ])
        
        idx = out.find('"vXmutd"')
        chunk = out[idx:idx+60] if idx != -1 else ''
        m_vx = re.findall(r'\\"([A-Z]{2})\\"', chunk)
        detected_country = m_vx[0] if (m_vx and m_vx[0] != 'ZZ') else None
        
        if not detected_country:
            m3 = re.findall(r',2,1,200,"([A-Z]{3})"', out)
            if m3 and m3[0] not in ['CHN', 'HKG']:
                detected_country = m3[0]

        if blocked:
            return {'supported': False, 'region': 'BLOCKED', 'status': '阻断(地区受限)'}
        elif len(out) > 50000:
            if detected_country:
                return {'supported': True, 'region': detected_country, 'status': f"支持({detected_country})"}
            else:
                return {'supported': True, 'region': 'OK', 'status': '支持(可用)'}
        else:
            return {'supported': False, 'region': None, 'status': '不可达'}
    except Exception:
        return {'supported': False, 'region': None, 'status': '超时'}

def probe_ip_and_chatgpt():
    ip_type = None
    proxy_handler = urllib.request.ProxyHandler({
        'http': f'http://127.0.0.1:{MIXED_PORT}',
        'https': f'http://127.0.0.1:{MIXED_PORT}'
    })
    opener = urllib.request.build_opener(proxy_handler)

    try:
        req_ip = urllib.request.Request('http://ip-api.com/json?fields=status,countryCode,hosting,query')
        with opener.open(req_ip, timeout=3) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if data.get('status') == 'success':
                ip_type = '机房(DCH)' if data.get('hosting') else '住宅(ISP)'
    except Exception:
        pass

    chatgpt_status = None
    loc = None
    try:
        req_cf = urllib.request.Request(
            'https://chatgpt.com/cdn-cgi/trace',
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with opener.open(req_cf, timeout=2.0) as resp:
            for line in resp.read().decode('utf-8', errors='ignore').splitlines():
                if line.startswith('loc='):
                    loc = line.split('=')[1].strip()
                    break
    except Exception:
        pass

    web_ok = False
    try:
        req_web = urllib.request.Request(
            'https://api.openai.com/compliance/cookie_requirements',
            headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                'Origin': 'https://platform.openai.com',
                'Referer': 'https://platform.openai.com/'
            }
        )
        with opener.open(req_web, timeout=2.5) as resp:
            body = resp.read().decode('utf-8', errors='ignore')
            if 'unsupported_country' not in body:
                web_ok = True
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='ignore')
        if e.code == 200 or ('unsupported_country' not in body and e.code != 403):
            web_ok = True
    except Exception:
        web_ok = False

    app_ok = False
    try:
        req_app = urllib.request.Request(
            'https://ios.chat.openai.com/',
            headers={
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
                'Authority': 'ios.chat.openai.com'
            }
        )
        with opener.open(req_app, timeout=2.5) as resp:
            app_ok = True
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='ignore')
        if 'Request is not allowed' not in body and 'dc' not in body and 'VPN' not in body and e.code != 403:
            app_ok = True
    except Exception:
        app_ok = False

    loc_tag = loc if loc else '未知'
    if not web_ok and not app_ok:
        chatgpt_status = {'supported': False, 'level': 'blocked', 'region': loc, 'status': f"阻断({loc_tag})"}
    elif web_ok and not app_ok:
        chatgpt_status = {'supported': True, 'level': 'web_only', 'region': loc, 'status': f"仅网页({loc_tag})"}
    elif not web_ok and app_ok:
        chatgpt_status = {'supported': True, 'level': 'app_only', 'region': loc, 'status': f"仅APP({loc_tag})"}
    else:
        chatgpt_status = {'supported': True, 'level': 'full', 'region': loc, 'status': f"全支持({loc_tag})"}

    return ip_type or '--', chatgpt_status

def format_ip_type(ip_t):
    if not ip_t or ip_t == '--':
        return "--"
    return f"{GREEN}{ip_t}{RESET}" if '住宅' in ip_t else f"{YELLOW}{ip_t}{RESET}"

def format_gemini_status(info):
    if not info:
        return "--"
    st = info.get('status', '未知')
    return f"{GREEN}{st}{RESET}" if info.get('supported') else f"{RED}{st}{RESET}"

def format_chatgpt_status(info):
    if not info:
        return "--"
    st = info.get('status', '未知')
    lvl = info.get('level', '')
    if lvl == 'full' or '全支持' in st:
        return f"{GREEN}{st}{RESET}"
    if lvl == 'web_only' or '仅网页' in st:
        return f"{YELLOW}{st}{RESET}"
    return f"{RED}{st}{RESET}"

def test_node_all_probes(node_name):
    api_request('PUT', '/proxies/Proxy', json.dumps({'name': node_name}))
    api_request('DELETE', '/connections')
    time.sleep(0.3)
    gemini_res = probe_gemini_unlock()
    ip_type, chatgpt_res = probe_ip_and_chatgpt()
    return gemini_res, ip_type, chatgpt_res

def test_download_speed(node_name):
    gemini_res, ip_type, chatgpt_res = test_node_all_probes(node_name)
    proxy_handler = urllib.request.ProxyHandler({
        'http': f'http://127.0.0.1:{MIXED_PORT}',
        'https': f'http://127.0.0.1:{MIXED_PORT}'
    })
    opener = urllib.request.build_opener(proxy_handler)
    req = urllib.request.Request(
        'https://speed.cloudflare.com/__down?bytes=2500000',
        headers={'User-Agent': 'Mozilla/5.0'}
    )
    t0 = time.time()
    try:
        with opener.open(req, timeout=8) as resp:
            ttfb = int((time.time() - t0) * 1000)
            data = resp.read()
            elapsed = time.time() - t0
            size_mb = len(data) / (1024 * 1024)
            mb_s = size_mb / elapsed
            mbps = mb_s * 8
            return mb_s, mbps, ttfb, gemini_res, ip_type, chatgpt_res
    except Exception:
        return 0.0, 0.0, None, gemini_res, ip_type, chatgpt_res

def run_test_session(preset_mode=None):
    nodes, cur_node = get_proxies()
    if not nodes:
        print(f"{RED}错误：无法连接到 Clash Verge，请确保 Clash Verge 正在运行！{RESET}")
        sys.exit(1)

    classified = classify_nodes_by_region(nodes)
    region_summary_parts = [f"{reg}({len(r_nodes)})" for reg, r_nodes in classified]
    region_summary = " | ".join(region_summary_parts)

    print(f"\n{BOLD}{CYAN}========================================================================================{RESET}")
    print(f"检测到可用节点总数：{BOLD}{len(nodes)}{RESET} 个  |  当前生效节点：{YELLOW}{cur_node}{RESET}")
    print(f"地区分布概览：{CYAN}{region_summary}{RESET}")
    print("----------------------------------------------------------------------------------------")
    
    if preset_mode:
        choice = preset_mode.lower()
    else:
        print("请选择测速模式：")
        print("  [a] 快速综合体检（5秒全节点并发测延迟、抖动与丢包率，0 流量消耗）")
        print("  [b] 优选真实测速（推荐：筛前10名测带宽、TTFB与Gemini/ChatGPT/IP类型）")
        print("  [c] 全节点深度测速（测试所有可用节点下载速度与双AI/IP属性，消耗约 85MB 流量）")
        print("  [d] AI与IP属性专项检测（批量检测各存活节点的IP类型、Gemini与ChatGPT状态，轻量极低流量）")
        print("  [e] 按国家/地区定向测试（选择某一个国家或地区的全部节点进行测速）")
        print("----------------------------------------------------------------------------------------")
        try:
            raw_input = input("请输入模式字母 [a/b/c/d/e 测速，直接敲回车立即退出关闭窗口]: ").strip().lower()
        except EOFError:
            raw_input = ''
        
        if not raw_input or raw_input in ['q', 'quit', 'exit']:
            sys.exit(99)
        
        mapping = {'1': 'a', '2': 'b', '3': 'c', '4': 'd', '5': 'e', 'a': 'a', 'b': 'b', 'c': 'c', 'd': 'd', 'e': 'e'}
        choice = mapping.get(raw_input, 'b')

    target_region_name = None
    target_nodes = nodes
    region_sub_choice = '1'

    if choice == 'e':
        print(f"\n{BOLD}{CYAN}----------------------------------------------------------------------------------------{RESET}")
        print(f"{BOLD}【国家/地区定向测速】请选择要测试的区域：{RESET}")
        for idx, (reg, r_nodes) in enumerate(classified, 1):
            print(f"  [{idx:2d}] {reg} (共 {len(r_nodes)} 个节点)")
        print("----------------------------------------------------------------------------------------")
        try:
            reg_input = input(f"请输入地区编号 [1-{len(classified)}，直接敲回车返回主菜单]: ").strip()
        except EOFError:
            reg_input = ''
        
        if not reg_input or not reg_input.isdigit() or not (1 <= int(reg_input) <= len(classified)):
            print("\n已返回主菜单。")
            return '__menu__'
        
        target_region_name, target_nodes = classified[int(reg_input) - 1]
        print(f"\n已选择地区：{BOLD}{GREEN}【{target_region_name}】{RESET}（共 {len(target_nodes)} 个可用节点）")
        print("请选择测试方式：")
        print(f"  [1] 真实深度测速（推荐：测全部 {len(target_nodes)} 个节点的真实下载带宽、TTFB与双AI/IP属性）")
        print(f"  [2] 快速延迟体检（并发测试全部 {len(target_nodes)} 个节点的延迟与丢包率，0 流量消耗）")
        print(f"  [3] AI与IP属性检测（批量检测全部 {len(target_nodes)} 个节点的IP类型、Gemini与ChatGPT状态，极低流量）")
        print("----------------------------------------------------------------------------------------")
        try:
            sub_in = input("请输入选项 [1/2/3，直接敲回车默认执行 1]: ").strip()
        except EOFError:
            sub_in = ''
        region_sub_choice = sub_in if sub_in in ['1', '2', '3'] else '1'

    mode_names = {
        'a': '快速综合体检（0 流量）',
        'b': '优选真实测速（前 10 强带宽与双 AI/IP 属性）',
        'c': '全节点深度测速（全量带宽与双 AI/IP 属性）',
        'd': 'AI 与 IP 属性专项检测（轻量批量）',
        'e': f'国家/地区定向测速【{target_region_name}】'
    }
    print(f"\n{BOLD}正在执行模式 [{choice}]：{mode_names.get(choice, choice)}{RESET}")
    print(f"{CYAN}全并发多轮探测目标节点 HTTPS 延迟与丢包率中...{RESET}")
    
    results = []
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(test_single_node_stability, name, p.get('type', '未知')): name for name, p in target_nodes.items()}
        for future in as_completed(futures):
            res = future.result()
            results.append(res)
            sys.stdout.write(f"\r进度：已完成 {len(results)}/{len(target_nodes)} 个节点探测...")
            sys.stdout.flush()

    print("\n")
    results.sort(key=lambda x: (not x['alive'], x['loss_rate'], x['avg_delay']))

    if choice in ['b', 'c'] or (choice == 'e' and region_sub_choice == '1'):
        if choice == 'b':
            test_targets = [r for r in results if r['loss_rate'] == 0][:10]
        elif choice == 'c':
            test_targets = [r for r in results if r['loss_rate'] == 0]
        else:
            test_targets = [r for r in results if r['loss_rate'] < 100 and r['alive']]
        
        print(f"{CYAN}开始对选中的 {len(test_targets)} 个节点进行真实下行带宽、TTFB 与 AI/IP 属性测速...{RESET}")
        try:
            for idx, item in enumerate(test_targets, 1):
                name = item['name']
                print(f"[{idx:2d}/{len(test_targets)}] 测速中: {name[:30]:<30}... ", end='', flush=True)
                mb_s, mbps, ttfb, gemini_res, ip_type, chatgpt_res = test_download_speed(name)
                item['speed_mbs'] = mb_s
                item['speed_mbps'] = mbps
                item['ttfb'] = ttfb
                item['gemini'] = gemini_res
                item['ip_type'] = ip_type
                item['chatgpt'] = chatgpt_res
                print(f"{GREEN}{mb_s:5.2f} MB/s{RESET} | IP:{format_ip_type(ip_type)} | Gem:{format_gemini_status(gemini_res)} | GPT:{format_chatgpt_status(chatgpt_res)}")
        finally:
            if cur_node:
                api_request('PUT', '/proxies/Proxy', json.dumps({'name': cur_node}))
                api_request('DELETE', '/connections')

        test_targets.sort(key=lambda x: (x.get('speed_mbs', 0), -(x.get('ttfb') or 9999)), reverse=True)
        rest = [r for r in results if r not in test_targets]
        final_list = test_targets + rest

    elif choice == 'd' or (choice == 'e' and region_sub_choice == '3'):
        test_targets = [r for r in results if r['loss_rate'] < 50 and r['alive']]
        print(f"{CYAN}开始对存活的 {len(test_targets)} 个节点进行 IP 属性、Gemini 与 ChatGPT 专项检测...{RESET}")
        try:
            for idx, item in enumerate(test_targets, 1):
                name = item['name']
                print(f"[{idx:2d}/{len(test_targets)}] 检测中: {name[:30]:<30}... ", end='', flush=True)
                gemini_res, ip_type, chatgpt_res = test_node_all_probes(name)
                item['gemini'] = gemini_res
                item['ip_type'] = ip_type
                item['chatgpt'] = chatgpt_res
                print(f"IP:{format_ip_type(ip_type)} | Gem:{format_gemini_status(gemini_res)} | GPT:{format_chatgpt_status(chatgpt_res)}")
        finally:
            if cur_node:
                api_request('PUT', '/proxies/Proxy', json.dumps({'name': cur_node}))
                api_request('DELETE', '/connections')

        test_targets.sort(key=lambda x: (
            not (x.get('gemini', {}).get('supported', False) and x.get('chatgpt', {}).get('supported', False)),
            '住宅' not in x.get('ip_type', ''),
            x['loss_rate'],
            x['avg_delay']
        ))
        rest = [r for r in results if r not in test_targets]
        final_list = test_targets + rest
    else:
        final_list = results

    # 绘制规整表格（共 12 列，总展示宽度 175）
    cols = [
        ('序号', 4, 'center'),
        ('节点名称', 36, 'left'),
        ('协议类型', 9, 'center'),
        ('真实延迟', 8, 'right'),
        ('网络抖动', 8, 'right'),
        ('丢包率', 6, 'right'),
        ('IP类型', 9, 'center'),
        ('Gemini判定', 11, 'center'),
        ('ChatGPT判定', 11, 'center'),
        ('首字节', 8, 'right'),
        ('下行带宽', 9, 'right'),
        ('综合评级', 19, 'left')
    ]

    top_border = '┌─' + '─┬─'.join('─' * c[1] for c in cols) + '─┐'
    header     = '│ ' + ' │ '.join(pad_to(c[0], c[1], c[2]) for c in cols) + ' │'
    sep_border = '├─' + '─┼─'.join('─' * c[1] for c in cols) + '─┤'
    bot_border = '└─' + '─┴─'.join('─' * c[1] for c in cols) + '─┘'

    print(top_border)
    print(header)
    print(sep_border)

    for idx, r in enumerate(final_list, 1):
        name = r['name']
        is_cur = (name == cur_node)
        disp_name = (name + f"{BOLD}{YELLOW}*已选{RESET}") if is_cur else name
        
        delay_val = r['avg_delay']
        if not r['alive']:
            delay_str = f"{RED}超时{RESET}"
        elif delay_val < 100:
            delay_str = f"{GREEN}{delay_val}ms{RESET}"
        elif delay_val < 200:
            delay_str = f"{YELLOW}{delay_val}ms{RESET}"
        else:
            delay_str = f"{RED}{delay_val}ms{RESET}"

        if not r['alive']:
            jitter_str = "--"
        else:
            jit = r.get('jitter', 0)
            if jit < 15:
                jitter_str = f"{GREEN}±{jit}ms{RESET}"
            elif jit < 45:
                jitter_str = f"{YELLOW}±{jit}ms{RESET}"
            else:
                jitter_str = f"{RED}±{jit}ms{RESET}"

        loss_rate = r['loss_rate']
        loss_str = f"{loss_rate}%" if loss_rate == 0 else f"{RED}{loss_rate}%{RESET}"

        ip_str = format_ip_type(r.get('ip_type'))
        gemini_str = format_gemini_status(r.get('gemini'))
        chatgpt_str = format_chatgpt_status(r.get('chatgpt'))

        ttfb = r.get('ttfb')
        if ttfb is None:
            ttfb_str = "--"
        elif ttfb < 350:
            ttfb_str = f"{GREEN}{ttfb}ms{RESET}"
        elif ttfb < 650:
            ttfb_str = f"{YELLOW}{ttfb}ms{RESET}"
        else:
            ttfb_str = f"{RED}{ttfb}ms{RESET}"

        speed = r.get('speed_mbs')
        if speed is not None:
            speed_str = f"{speed:.2f} MB/s"
        else:
            speed_str = "--"

        if not r['alive'] or loss_rate == 100:
            eval_str = f"{RED}不可用{RESET}"
        elif loss_rate > 0:
            eval_str = f"{YELLOW}严重丢包({loss_rate}%){RESET}"
        elif speed is not None:
            if speed >= 1.5 and (ttfb is not None and ttfb < 400):
                eval_str = f"{GREEN}{BOLD}极度流畅 ★★★★★{RESET}"
            elif speed >= 0.8:
                eval_str = f"{GREEN}高速稳定 ★★★★{RESET}"
            elif speed < 0.4:
                eval_str = f"{YELLOW}虚假低延(限速) ★★{RESET}"
            else:
                eval_str = f"{CYAN}流畅可用 ★★★{RESET}"
        elif r.get('jitter', 0) > 50:
            eval_str = f"{YELLOW}高抖动 ★★{RESET}"
        else:
            eval_str = f"{CYAN}低延稳定 ★★★{RESET}"

        row_data = [
            str(idx),
            disp_name,
            r['proto'],
            delay_str,
            jitter_str,
            loss_str,
            ip_str,
            gemini_str,
            chatgpt_str,
            ttfb_str,
            speed_str,
            eval_str
        ]

        row_line = '│ ' + ' │ '.join(pad_to(row_data[i], cols[i][1], cols[i][2]) for i in range(len(cols))) + ' │'
        print(row_line)

    print(bot_border)

    best = final_list[0]
    rec_title = f"【系统客观推荐（地区：{target_region_name}）】" if target_region_name else "【系统客观推荐】"
    print(f"\n{BOLD}{GREEN}{rec_title}{RESET}")
    gem_best = best.get('gemini')
    gpt_best = best.get('chatgpt')
    ip_best = best.get('ip_type')
    
    extra_rec = []
    if ip_best and ip_best != '--':
        extra_rec.append(f"IP类型：{format_ip_type(ip_best)}")
    if gem_best:
        extra_rec.append(f"Gemini：{format_gemini_status(gem_best)}")
    if gpt_best:
        extra_rec.append(f"ChatGPT：{format_chatgpt_status(gpt_best)}")
    extra_rec_str = (" | " + " | ".join(extra_rec)) if extra_rec else ""

    if best.get('speed_mbs'):
        ttfb_info = f" | 首字节：{CYAN}{best.get('ttfb')}ms{RESET}" if best.get('ttfb') else ""
        jit_info = f" | 抖动：±{best['jitter']}ms"
        print(f"首选节点：{BOLD}{best['name']}{RESET} | 协议：{CYAN}{best['proto']}{RESET} | 速度：{GREEN}{best['speed_mbs']:.2f} MB/s ({best['speed_mbps']:.1f} Mbps){RESET} | 延迟：{best['avg_delay']}ms{jit_info}{ttfb_info}{extra_rec_str}")
    elif best['alive']:
        print(f"首选节点：{BOLD}{best['name']}{RESET} | 协议：{CYAN}{best['proto']}{RESET} | 延迟：{best['avg_delay']}ms (抖动: ±{best['jitter']}ms, 0% 丢包){extra_rec_str}")

    hy2_count = sum(1 for r in final_list[:10] if 'Hysteria' in r.get('proto', ''))
    if hy2_count > 0:
        print(f"{YELLOW}💡 协议规律提示：前列存在 Hysteria2 协议节点。该协议基于 UDP，在晚高峰网络丢包拥堵时通常抗抖动能力和吞吐量远强于 Trojan。{RESET}")

    # 一体化多路操作控制台
    print("----------------------------------------------------------------------------------------")
    print(f"{BOLD}操作指令：{RESET}")
    print("  • 输入【数字序号】（如 1、2）   ：直接将 Clash Verge 切换到对应节点")
    print("  • 输入【模式字母】（a/b/c/d/e） ：直接以指定模式开始新一轮测速")
    print("  • 直接按【回车键】             ：结束测试流程并退出")
    
    try:
        user_cmd = input("\n请输入指令 [数字选节点 / 字母切模式 / 回车结束]: ").strip().lower()
    except EOFError:
        user_cmd = ""

    if user_cmd in ['a', 'b', 'c', 'd', 'e']:
        return user_cmd

    if user_cmd.isdigit():
        s_idx = int(user_cmd)
        if 1 <= s_idx <= len(final_list):
            target = final_list[s_idx - 1]['name']
            st, _ = api_request('PUT', '/proxies/Proxy', json.dumps({'name': target}))
            api_request('PUT', '/proxies/GLOBAL', json.dumps({'name': target}))
            if st in [200, 204]:
                print(f"\n{GREEN}✓ 成功将 Clash Verge 切换至：{target}{RESET}")
            else:
                print(f"\n{RED}切换失败，状态码：{st}{RESET}")
            
            try:
                next_cmd = input("\n已切换节点。如需换模式重测请输入字母 (a/b/c/d/e)，直接按回车结束退出: ").strip().lower()
                if next_cmd in ['a', 'b', 'c', 'd', 'e']:
                    return next_cmd
            except EOFError:
                pass
        else:
            print("\n输入序号超出范围。")

    return None

def main():
    print(f"{BOLD}{CYAN}========================================================================================{RESET}")
    print(f"{BOLD}{CYAN}                       Clash Verge 节点多维客观测速工具（Mac 版）                          {RESET}")
    print(f"{BOLD}{CYAN}========================================================================================{RESET}")
    print("正在连接 Clash Verge API（应用程序编程接口）...")

    next_mode = None
    while True:
        res = run_test_session(preset_mode=next_mode)
        if res == '__menu__':
            next_mode = None
            continue
        next_mode = res
        if not next_mode:
            break

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print(f"\n{YELLOW}用户中断操作。{RESET}")
    sys.exit(0)
