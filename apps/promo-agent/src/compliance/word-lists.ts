export interface Violation {
  word: string;
  reason: string;
  severity: "block" | "warn";
  replacement?: string;
}

export const RUSSIAN_AD_LAW: Violation[] = [
  { word: "лучший", reason: "俄罗斯广告法禁止'最好'等最高级", severity: "block", replacement: "качественный" },
  { word: "номер один", reason: "禁止'第一'声明", severity: "block", replacement: "популярный" },
  { word: "номер 1", reason: "禁止'第一'声明", severity: "block", replacement: "популярный" },
  { word: "№1", reason: "禁止'第一'声明", severity: "block", replacement: "популярный" },
  { word: "гарантия", reason: "禁止无依据的'保证'声明", severity: "warn", replacement: "уверенность в качестве" },
  { word: "100%", reason: "禁止绝对化百分比声明", severity: "block", replacement: "высокий" },
  { word: "бесплатно", reason: "禁止'免费'声明（除非真实促销）", severity: "warn", replacement: "в подарок" },
  { word: "скидка 90%", reason: "禁止夸大折扣", severity: "block" },
  { word: "скидка 80%", reason: "禁止夸大折扣", severity: "block" },
  { word: "эксклюзивно", reason: "禁止'独家'声明", severity: "warn", replacement: "оригинальный" },
  { word: "уникальный", reason: "禁止'独特'声明", severity: "warn", replacement: "особенный" },
  { word: "супер", reason: "Ozon 禁止夸张修饰词", severity: "warn", replacement: "" },
  { word: "мега", reason: "Ozon 禁止夸张修饰词", severity: "warn", replacement: "" },
  { word: "хит", reason: "Ozon 禁止'爆款'声明", severity: "warn", replacement: "популярный" },
  { word: "топ", reason: "Ozon 禁止'排行'声明", severity: "warn", replacement: "популярный" },
  { word: "лечит", reason: "禁止医疗效果声明", severity: "block" },
  { word: "излечивает", reason: "禁止医疗效果声明", severity: "block" },
  { word: "лекарство", reason: "非药品禁止声明为药品", severity: "block" },
  { word: "косметический хирург", reason: "禁止整形效果声明", severity: "block" },
  { word: "похудение", reason: "禁止减肥效果声明", severity: "block" },
  { word: "сертифицировано", reason: "禁止无依据的认证声明", severity: "block" },
  { word: "FDA", reason: "禁止未经核实的 FDA 声明", severity: "block" },
  { word: "CE", reason: "禁止未经核实的 CE 声明", severity: "warn" },
  { word: "ISO", reason: "禁止未经核实的 ISO 声明", severity: "warn" },
  { word: "дешевле чем", reason: "禁止与竞品价格对比", severity: "block" },
  { word: "дешевле, чем", reason: "禁止与竞品价格对比", severity: "block" },
];

export const OZON_PLATFORM_RULES: Violation[] = [
  { word: "купите сейчас", reason: "Ozon 禁止强促性用语", severity: "warn", replacement: "доступен для заказа" },
  { word: "ограниченное предложение", reason: "Ozon 限制虚假稀缺性声明", severity: "warn", replacement: "" },
  { word: "не упустите", reason: "Ozon 限制强促性用语", severity: "warn", replacement: "" },
  { word: "торопитесь", reason: "Ozon 限制催促性用语", severity: "warn", replacement: "" },
  { word: "акция", reason: "非官方促销活动禁止使用'促销'", severity: "warn", replacement: "" },
  { word: "распродажа", reason: "非官方促销活动禁止使用'清仓'", severity: "warn", replacement: "" },
  { word: "новинка", reason: "非新品禁止标注'新品'", severity: "warn", replacement: "" },
  { word: "оригинал", reason: "非品牌授权禁止标注'原装'", severity: "block" },
  { word: "подлинный", reason: "非品牌授权禁止标注'正品'", severity: "block" },
  { word: "реплика", reason: "Ozon 禁止销售仿品", severity: "block" },
  { word: "копия", reason: "Ozon 禁止销售仿品", severity: "block" },
];

export const CHINA_AD_LAW: Violation[] = [
  { word: "最", reason: "中国广告法禁止'最'字级声明", severity: "block", replacement: "很" },
  { word: "第一", reason: "中国广告法禁止'第一'声明", severity: "block", replacement: "领先" },
  { word: "国家级", reason: "中国广告法禁止'国家级'声明", severity: "block" },
  { word: "绝对", reason: "中国广告法禁止绝对化用语", severity: "block", replacement: "非常" },
  { word: "100%有效", reason: "禁止无依据的效果保证", severity: "block" },
  { word: "包治", reason: "禁止医疗效果保证", severity: "block" },
  { word: "根治", reason: "禁止医疗效果保证", severity: "block" },
  { word: "无效退款", reason: "禁止无依据的退款承诺", severity: "block" },
];

export const ALL_VIOLATIONS: Violation[] = [
  ...RUSSIAN_AD_LAW,
  ...OZON_PLATFORM_RULES,
  ...CHINA_AD_LAW,
];
