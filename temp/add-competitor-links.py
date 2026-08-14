# -*- coding: utf-8 -*-
"""
Ozon 卖家后台竞品链接批量添加（WebBridge 操作 seller.ozon.ru）
流程：价格页定位 SKU 行"未指定"旁的"添加"→ 弹窗逐条 insertText → 点"添加" → "发送以进行审核"。
用法：python temp/add-competitor-links.py [只处理某 offerId]
"""
import json, sys, time, urllib.request, io
sys.stdout.reconfigure(encoding="utf-8")

WB = "http://127.0.0.1:10086/command"
SESSION = "onzo-competitor-scan"

# SKU → 竞品链接（与服务器 promo_competitor_links 一致，2026-08-13 调研留档）
DATA = {
    "GEN-CARB-168F-01": [
        "https://www.ozon.ru/product/karbyurator-gaz-benzin-dlya-dvigateley-168f-170f-gx160-gx200-dvuhtoplivnyy-dlya-generatorov-5234519016/",
        "https://www.ozon.ru/product/karbyurator-gaz-benzin-dlya-generatora-elektrostantsiy-3-kvt-dvigatel-6-5-7-ls-168f-170f-1611746442/",
        "https://www.ozon.ru/product/karbyurator-dlya-generatora-3-kvt-dvigatel-6-5-7-l-s-168f-170f-1636110115/",
        "https://www.ozon.ru/product/karbyurator-dlya-motoblokov-motopomp-i-dvigateley-modeley-lifan-lifan-168f-168f-1-168f-2-170f-4207398574/",
        "https://www.ozon.ru/product/karbyurator-s-gazovym-reduktorom-168f-170f-gaz-benzin-na-generator-elektrostantsiy-3-kvt-5164772611/",
        "https://www.ozon.ru/product/dvuhtoplivnyy-gazovyy-karbyurator-brenda-spd-dlya-invertornyh-generatorov-2-kvt-dvigatel-gx200-5031467106/",
    ],
    "MAR-YAM-61N-01": [
        "https://www.ozon.ru/product/remkomplekt-karbyuratora-skipper-dlya-yamaha-25b-30h-oem-61n-w0093-00-3g2-87122-2-803826a1-1085340338/",
        "https://www.ozon.ru/product/remkomplekt-karbyuratora-lodochnogo-motora-yamaha-9-9-15-l-s-63v-14301-2642979237/",
        "https://www.ozon.ru/product/remkomplekt-karbyuratora-tohatsu-mercury-mizashi-1675854612/",
        "https://www.ozon.ru/product/63v-w0093-00-remkomplekt-karbyuratora-lodochnogo-motora-sovmestim-s-2-taktnogo-podvesnogo-4950071692/",
    ],
    "MAR-COVER-M": [
        "https://www.ozon.ru/product/chehol-dlya-motora-moshchnostyu-ot-9-9-do-18-l-s-usilennyy-440103566/",
        "https://www.ozon.ru/product/sumka-chehol-dlya-lodochnogo-motora-9-9-15-ls-2t-6-9-8-ls-4t-4833777844/",
        "https://www.ozon.ru/product/sumka-dlya-lodochnyh-motorov-ot-9-9-do-18-l-s-chernaya-588629217/",
    ],
    "MAR-YAM-6E7-01": [
        "https://www.ozon.ru/product/vtulka-grebnogo-vinta-rezinovaya-yamaha-9-9-20-3173237511/",
        "https://www.ozon.ru/product/vtulka-grebnogo-vinta-2129622188/",
        "https://www.ozon.ru/product/vtulka-grebnogo-vinta-rezinovaya-yamaha-25-30-3173192285/",
        "https://www.ozon.ru/product/ustanovochnyy-komplekt-grebnogo-vinta-dlya-plm-yamaha-9-9-15-l-s-6e7-45987-00-1606934059/",
        "https://www.ozon.ru/product/shayba-grebnogo-vinta-upornaya-opornaya-yamaha-9-9-15-l-s-i-f9-9-15-20-oem-6e7-45987-01-00-yatw-1919213419/",
        "https://www.ozon.ru/product/58120-93701-dempfernaya-rezina-vtulka-grebnogo-vinta-dlya-lodochnogo-dvigatelya-2011702736/",
        "https://www.ozon.ru/product/shayba-upornaya-grebnogo-vinta-yamaha-9-9-20-6e7-45987-01-00-1389038021/",
    ],
    "CN-HAV-H6-DOOR-01": [
        "https://www.ozon.ru/product/tros-zamka-dveri-peredney-ot-zamka-k-naruzhnoy-ruchke-29-sm-rubashka-38-sm-dlina-haval-n6-haval-1965899888/",
        "https://www.ozon.ru/product/haval-tros-zamka-dveri-pered-art-6105109xkz16a-1-sht-2908696099/",
        "https://www.ozon.ru/product/tros-zamka-dveri-peredney-ot-zamka-k-ruchke-naruzhnoy-haval-h6-1-5-16v-6at-vnedorozhnik-4x2-1422487945/",
        "https://www.ozon.ru/product/tros-zamka-dveri-peredney-ot-zamka-k-ruchke-naruzhnoy-haval-h6-1-5-16v-6mt-vnedorozhnik-4x2-1422487166/",
        "https://www.ozon.ru/product/tros-zamka-dveri-1116886379/",
        "https://www.ozon.ru/product/trosik-zamka-peredney-dveri-haval-h6-ot-naruzhney-ruchki-k-zamku-2303848777/",
        "https://www.ozon.ru/product/trosik-zamka-otkrytiya-dveri-peredney-levoy-ot-zamka-k-naruzhnoy-ruchke-haval-h6-4435916881/",
        "https://www.ozon.ru/product/trosik-zamka-otkrytiya-dveri-peredney-levoy-ot-zamka-k-naruzhnoy-ruchke-haval-h6-4387566192/",
    ],
    "MAR-YAM-67F-01": [
        "https://www.ozon.ru/product/krylchatka-pompy-yamaha-f75-f100-67f-44352-00-67f-44352-01-1844050234/",
        "https://www.ozon.ru/product/krylchatka-pompy-yamaha-f75-100l-s-67f-44352-00-488249718/",
        "https://www.ozon.ru/product/krylchatka-pompy-ohlazhdeniya-lodochnogo-motora-yamaha-75-80-90-100hp-67f-44352-01-1547351619/",
    ],
}

def wb(action, args, timeout=90):
    body = json.dumps({"action": action, "args": args, "session": SESSION}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(WB, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.loads(r.read().decode("utf-8"))
    if not resp.get("ok"):
        raise RuntimeError(json.dumps(resp.get("error", {}), ensure_ascii=False)[:200])
    return resp.get("data", {})

def js(code):
    d = wb("evaluate", {"code": code})
    v = d.get("value") if isinstance(d, dict) else d
    return v

def click_xy(x, y):
    wb("cdp", {"method": "Input.dispatchMouseEvent", "params": {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1}})
    wb("cdp", {"method": "Input.dispatchMouseEvent", "params": {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1}})

def find_add_link(offer_id):
    """在价格页找指定 SKU 行'未指定'旁的'添加'链接坐标（先滚动到该行）"""
    code = """
    (() => {
      const rows = [...document.querySelectorAll('tr')].filter(tr => (tr.innerText || '').includes('%s'));
      if (!rows.length) return 'ROW_NOT_FOUND';
      const row = rows[0];
      row.scrollIntoView({ block: 'center' });
      const cells = [...row.querySelectorAll('td')];
      for (const td of cells) {
        if ((td.innerText || '').includes('未指定')) {
          const link = [...td.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '添加');
          if (link) {
            const r = link.getBoundingClientRect();
            return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
          }
        }
      }
      return 'ADD_NOT_FOUND';
    })()
    """ % offer_id
    return js(code)

def open_dialog(x, y):
    click_xy(x, y)
    time.sleep(3)
    ok = js("!!document.querySelector(\"input[placeholder*='粘贴'], input[placeholder*='链接']\")")
    return ok

def add_one_link(url):
    js("(document.querySelector(\"input[placeholder*='粘贴'], input[placeholder*='链接']\")||{focus(){}}).focus()")
    wb("cdp", {"method": "Input.insertText", "params": {"text": url}})
    time.sleep(1)
    # 弹窗内"添加"按钮（排除背景行：取可见且父容器含"商品链接"的）
    pos = js("""
    (() => {
      const btns = [...document.querySelectorAll('button')].filter(b => (b.innerText || '').trim() === '添加');
      const dlg = btns.filter(b => {
        let p = b; for (let i = 0; i < 6 && p; i++) { if ((p.innerText || '').includes('待添加链接') || (p.innerText || '').includes('您可添加其他平台')) return true; p = p.parentElement; } return false;
      });
      const b = dlg[0] || btns[btns.length - 1];
      if (!b) return 'NO_BTN';
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()
    """)
    if isinstance(pos, str) and pos.startswith('{'):
        p = json.loads(pos)
        click_xy(p["x"], p["y"])
        time.sleep(2)
    else:
        raise RuntimeError("添加按钮未找到: " + str(pos))

def submit():
    pos = js("""
    (() => { const b = [...document.querySelectorAll('button')].find(b => (b.innerText || '').includes('发送以进行审核'));
      if (!b) return 'NO_SUBMIT'; const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()
    """)
    if isinstance(pos, str) and pos.startswith('{'):
        p = json.loads(pos)
        click_xy(p["x"], p["y"])
        time.sleep(4)
        return True
    return False

def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    # 确保在价格页
    wb("navigate", {"url": "https://seller.ozon.ru/app/prices"})
    time.sleep(7)
    for offer_id, links in DATA.items():
        if only and offer_id != only:
            continue
        print(f"\n=== {offer_id}（{len(links)} 条）===")
        pos = find_add_link(offer_id)
        if not (isinstance(pos, str) and pos.startswith('{')):
            print(f"  跳过：{pos}（可能已有竞品数据或不在本页）")
            continue
        p = json.loads(pos)
        if not open_dialog(p["x"], p["y"]):
            print("  弹窗未打开，跳过")
            continue
        ok_count = 0
        for url in links:
            try:
                add_one_link(url)
                ok_count += 1
                print(f"  + {url[-45:]}")
            except Exception as e:
                print(f"  ! 失败 {url[-45:]}: {e}")
        if ok_count and submit():
            print(f"  ✓ 已提交 {ok_count} 条审核")
        else:
            print("  ✗ 提交失败或无有效链接")
        time.sleep(3)

if __name__ == "__main__":
    main()
