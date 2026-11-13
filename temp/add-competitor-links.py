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
    "MAR-YAM-66T-01": [
        "https://www.ozon.ru/product/remkomplekt-karbyuratora-yamaha-40x-e40x-66t-w0093-01-2850638004/",
        "https://www.ozon.ru/product/remkomplekt-karbyuratora-66t-yamaha-40x-premarine-2940068889/",
        "https://www.ozon.ru/product/o094f-66t-w0093-00-remontnyy-komplekt-karbyuratora-podvesnye-detali-dlya-yamaha-40-hp-2t-1877913211/",
        "https://www.ozon.ru/product/q-p-j-b-komplekt-dlya-remonta-karbyuratora-66t-w0093-00-podvesnye-detali-40-2t-aksessuary-5076856943/",
    ],
    "MAR-YAM-6E5-01": [
        "https://www.ozon.ru/product/remkomplekt-karbyuratora-dlya-yamaha-115-225-6e5-w0093-06-00-5172747828/",
        "https://www.ozon.ru/product/remkomplekt-karbyuratora-18-7002-dlya-lodochnogo-motora-yamaha-v4-v6-6e5-w0093-06-00-5371518572/",
        "https://www.ozon.ru/product/remkomplekt-karbyuratora-18-7002-dlya-lodochnogo-motora-yamaha-v4-v6-6e5-w0093-06-00-4851329354/",
        "https://www.ozon.ru/product/remkomplekt-karbyuratora-18-7002-dlya-lodochnogo-motora-yamaha-v4-v6-6e5-w0093-06-00-4602068587/",
    ],
    "MAR-PUMP-61N-01": [
        "https://www.ozon.ru/product/remkomplekt-pompy-dlya-lodochnyh-motorov-yamaha-25-30-2t-61n-w0078-69p-w0078-5143851229/",
        "https://www.ozon.ru/product/remkomplekt-pompy-dlya-yamaha-25-30-l-s-2t-61n-w0078-11-s-korpusom-2909195201/",
        "https://www.ozon.ru/product/remkomplekt-pompy-ohlazhdeniya-yamaha-25-30-f25-30-61n-w0078-omax-2745679711/",
    ],
    # ZERK-T8P-L 瑞虎8Pro左加热镜片（2026-10-20）：同车型精准竞品（8ProMax同款+7ProMax强手+7Pro）
    "ZERK-T8P-L": [
        "https://www.ozon.ru/product/zerkalnyy-element-levyy-s-obogrevom-dlya-avtomobilya-chery-tiggo-8-pro-max-i-1-pokolenie-2021-2723843455/",
        "https://www.ozon.ru/product/zerkalnyy-element-levyy-s-obogrevom-dlya-avtomobilya-chery-tiggo-7-pro-max-i-1-pokolenie-2022-1410921372/",
        "https://www.ozon.ru/product/zerkalnyy-element-levyy-s-obogrevom-dlya-avtomobilya-chery-tiggo-7-pro-i-1-pokolenie-2019-1410912953/",
    ],
    # ZERK-T8P-R 瑞虎8Pro右加热镜片（2026-10-20）：右侧 Ergon 8Pro 专用 2 条+通用件价格锚 1 条
    "ZERK-T8P-R": [
        "https://www.ozon.ru/product/zerkalnyy-element-pravyy-chery-tiggo-8-pro-21-sfera-neytralnyy-s-obogrevom-1740736830/",
        "https://www.ozon.ru/product/zerkalnyy-element-dlya-avtomobilya-chery-tiggo-8-pro-21-sfera-neytralnyy-s-obogrevom-pravaya-1750307920/",
        "https://www.ozon.ru/product/zerkalnyy-element-levogo-zerkala-dlya-chery-tiggo-4-4-pro-7-pro-8-8-pro-8-pro-max-j68-8202110ba-2995668092/",
    ],
    # PZ30B 化油器（2026-09-19）：牵引车场景精准竞品（复核员验证）
    "MOT-CARB-PZ30-01": [
        "https://www.ozon.ru/product/karbyurator-pz30-na-mototsikl-motobuksirovshchik-200-250ss-pz-30-985504393/",
        "https://www.ozon.ru/product/karbyurator-pz30-dlya-motobuksirovshchika-13-22-l-s-t3-3589642478/",
    ],
    # 188F 双燃料化油器（2026-09-26）：发电机改 LPG 场景精准竞品
    "GEN-CARB-188F-02": [
        "https://www.ozon.ru/product/karbyurator-gaz-i-benzin-dlya-generatora-elektrostantsiy-4-9kvt-188f-190f-192f-gx340-gx390-5845819034/",
        "https://www.ozon.ru/product/karbyurator-gaz-benzin-dlya-generatora-elektrostantsiy-5-10-kvt-dvigatel-13-18ls-188f-190f-192f-1619983913/",
        "https://www.ozon.ru/product/trehtoplivnyy-karbyurator-s-avtomaticheskoy-zaslonkoy-dlya-dvigateley-188f-190f-gx390-5756089169/",
    ],
    # 33x14-1120 雪地摩托 CVT 皮带（2026-09-27）：精准尺寸竞品（已排除 34.5/30 错尺寸；ozon-buyer MCP 撞验证码，改 WebSearch 验证）
    "GEN-BELT-33X14-01": [
        "https://www.ozon.ru/product/remen-variatora-33h14-1120-dlya-snegohoda-buran-rys-tayga-variatornyy-remen-dlya-motobuksirovshchika-1661575255/",  # Rubena ArctiCA 4728 评（类目王）
        "https://www.ozon.ru/product/rubena-s-r-o-33h14-1120-remen-variatora-safari-dlya-snegohoda-buran-rys-tayga-dlya-vezdehoda-karakat-3555502128/",  # RUBENA s.r.o. ArctiCA 官方卡
        "https://www.ozon.ru/product/toyopower-33x14-1120-remen-variatora-dlya-snegohoda-buran-rys-tayga-dlya-vezdehoda-karakat-5144394988/",  # TOYOPOWER 白牌价格竞品
    ],
    # 35x1126 雪地摩托 CVT 皮带（2026-09-27，Тайга Варяг 550 原配）：已后台提交实证
    # 3560338482 被 Ozon 拒收（该SKU的商品未在Ozon上销售）→ 换 1887285378（前台实证在售，描述实证 1126*35мм+Тайга 550 SWT，5419₽）
    "GEN-BELT-35X1126-01": [
        "https://www.ozon.ru/product/remen-variatora-dlya-snegohoda-yamaha-tayga-1126-35-40g4340-8dn-17641-00-414617500-1887285378/",  # 实证在售 1126*35мм Тайга 550（替换被拒卡）
        "https://www.ozon.ru/product/remen-variatora-tayga-varyag-550-1126-35mm-originalnoe-kachestvo-dlya-yamaha-viking-540-3415746292/",  # Тайга 550+Viking 540（已入库）
        "https://www.ozon.ru/product/remen-variatora-dlya-snegohoda-tayga-varyag-550-i-yamaha-viking-540-razmer-1126-35mm-4843317615/",  # 双标卡（已入库）
    ],
    # 61N-26311-00 船外机油门拉线（2026-09-27）：трос газ реверс ямаха 族头部白牌卡（主 Agent 9/27 前台实证：CONTROL 593评/LODKA 1027评/winibo，价格带 1576-1637₽）
    # ⚠️ SKU 短链形式：完整 slug 未留档，ozon-buyer MCP 撞验证码；Ozon 短链 /product/{sku}/ 官方 301 到完整 slug，表单若拒收由主 Agent 浏览器补 slug（见 temp/listing-61ncable/competitor-links.json）
    "MAR-YAM-61N-CABLE-01": [
        "https://www.ozon.ru/product/3321402268/",  # CONTROL трос газа/реверса 白牌头部卡 593 评
        "https://www.ozon.ru/product/2307138629/",  # LODKA 白牌头部卡 1027 评
        "https://www.ozon.ru/product/1846466398/",  # winibo 白牌卡
    ],
    # 66T-26311 船外机油门拉线 40HP（2026-09-27）：40HP 拉线主流带 1579-1651₽（winibo 339评，无品牌墙）
    "MAR-YAM-66T-CABLE-01": [
        "https://www.ozon.ru/product/1701884696/",  # winibo 1651₽ 339评（brief 前台实证）⚠️ SKU 短链同 61N-CABLE 口径
        "https://www.ozon.ru/product/1701868489/",  # winibo 1579₽ 339评（brief 前台实证）⚠️ 同上
        "https://www.ozon.ru/product/tros-gaza-dlya-yamaha-2t-40hp-40x-66t-26311-00-5564525515/",  # 66T-26311-00 精准件号卡（WebSearch 实证在售，完整 slug）
    ],
    # CN-AUTO-GRILLE-COVER-01 水箱保温罩（2026-09-27）：通用款主流带 1,057-1,715₽ 无品牌墙（brief 前台实证）⚠️ SKU 短链同 61N-CABLE 口径
    "CN-AUTO-GRILLE-COVER-01": [
        "https://www.ozon.ru/product/2484288549/",  # Jolion 专用卡（本土 Автостиль）1,909₽ 203评
        "https://www.ozon.ru/product/1683067994/",  # 通用头部卡 1,669₽ 655-693评
        "https://www.ozon.ru/product/5505223853/",  # DeliNight 1,057₽
    ],
    # MOT-MIK-VM34-KIT-01 Mikuni VM30/32/34 化油器修理包（2026-10-01）：主流带 604-773₽ 无品牌墙（2026-10-01 前台快照实证）
    # ⚠️ SKU 短链形式：完整 slug 未留档，ozon-buyer MCP 撞 Antibot Captcha；短链 /product/{sku}/ 官方 301 到完整 slug，表单若拒收由主 Agent 浏览器补 slug
    "MOT-MIK-VM34-KIT-01": [
        "https://www.ozon.ru/product/2775779558/",  # LukiMotors 604₽ 56评（主流带下沿）
        "https://www.ozon.ru/product/836356307/",  # SPI 773₽ 37评（主流带上沿）
        "https://www.ozon.ru/product/2974211086/",  # speedpark 731₽ 4评
    ],
    # MOT-168F-CLUTCH-01 168F/170F 牵引车离合器碟片组（2026-10-01）：精准段 1,088-1,944₽（663₽ 为泛摩托聚合非直接对手）
    # ⚠️ SKU 短链同 VM34-KIT 口径（ozon-buyer MCP 撞 Antibot）
    "MOT-168F-CLUTCH-01": [
        "https://www.ozon.ru/product/1541692260/",  # Lifan Motors 1,088₽ 176评（精准段下沿，非巨头）
        "https://www.ozon.ru/product/1375010785/",  # RSMOTO 1,723₽ 35评
        "https://www.ozon.ru/product/1262619571/",  # LukiMotors 1,944₽ 72评
    ],
    # CN-DASHCOVER-JOLION-01 仪表台避光垫（2026-10-08）：主流带 1,250-1,500₽ 头部 359评 无垄断墙（brief 前台实证）⚠️ SKU 短链同上
    "CN-DASHCOVER-JOLION-01": [
        "https://www.ozon.ru/product/999043637/",   # накидка на торпедо 头部卡 359评
        "https://www.ozon.ru/product/3816066894/",  # 同型款（专版）仅 1评——本土覆盖慢实证
        "https://www.ozon.ru/product/5934197149/",  # 欧缔兰 2,319₽ 高价锚
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
