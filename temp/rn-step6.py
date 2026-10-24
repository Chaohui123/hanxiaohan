# -*- coding: utf-8 -*-
"""step6：填个人信息+选支付宝（不提交，留给用户）"""
import json, os, time, urllib.request, sys
sys.stdout.reconfigure(encoding="utf-8")
WB = "http://127.0.0.1:10086/command"
SESSION = "onzo-competitor-scan"
account_password = os.environ.get("RACKNERD_PASSWORD")
if not account_password:
    raise SystemExit("RACKNERD_PASSWORD is required; set it in the environment before filling the form")

def wb(action, args, timeout=120):
    body = json.dumps({"action": action, "args": args, "session": SESSION}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(WB, data=body, headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req, timeout=timeout)
    return json.loads(resp.read().decode("utf-8"))

def js(code):
    try:
        d = wb("evaluate", {"code": code})
    except Exception as e:
        return "JS_ERR:" + str(e)[:80]
    if not d.get("ok"):
        return "ERR:" + json.dumps(d.get("error", {}), ensure_ascii=False)[:150]
    data = d.get("data", {})
    return data.get("value") if isinstance(data, dict) else data

FIELDS = {
    "firstname": "Xiaohan",
    "lastname": "Han",
    "email": "584001555@qq.com",
    "address1": "Dongguan",
    "city": "Dongguan",
    "postcode": "523000",
    "password": account_password,
    "password2": account_password,
}

r = js("""
(() => {
  const fields = %s;
  const out = [];
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  for (const [name, val] of Object.entries(fields)) {
    const el = document.querySelector('input[name=' + name + ']');
    if (!el) { out.push(name + ':NF'); continue; }
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    out.push(name + ':OK');
  }
  // 国家选择
  const c = document.querySelector('select[name=country]');
  if (c) {
    const opt = [...c.options].find(o => /china/i.test(o.text));
    if (opt) { c.value = opt.value; c.dispatchEvent(new Event('change', { bubbles: true })); out.push('country=' + opt.text.trim()); }
  }
  // 电话（若有）
  const p = document.querySelector('input[name=phonenumber]');
  if (p) { setter.call(p, '13800000000'); p.dispatchEvent(new Event('input', { bubbles: true })); out.push('phone=13800000000'); }
  // 支付宝
  const radio = document.querySelector('input[type=radio][value=dplstripe_alipay]');
  if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); radio.click(); out.push('pay=Alipay'); }
  return JSON.stringify(out);
})()
""" % json.dumps(FIELDS, ensure_ascii=False))
print("fill:", r)
time.sleep(2)
# 截图确认
d = wb("screenshot", {"format": "jpeg", "quality": 70})
print("shot:", d.get("data", {}).get("path"))
