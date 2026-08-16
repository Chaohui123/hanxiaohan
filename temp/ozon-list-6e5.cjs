// 化油器修理包建品 MAR-YAM-6E5-01（61N/66T 同族结构；红线：标题/标签零品牌词；4191 禁 оригинал*）
const fs = require("fs");
const { ozon } = require("./ozon-api.cjs");

const dict = (id, did, value) => ({ complex_id: 0, id, values: [{ dictionary_value_id: did, value }] });
const text = (id, value) => ({ complex_id: 0, id, values: [{ value }] });

const TITLE = "Ремкомплект карбюратора 115-130 л.с. (V4/V6), аналог 6E5-W0093-06-00";
if (TITLE.length > 100) throw new Error("标题超 100 字符");

const IMGS = [
  "https://huashangshangmao.top/images/7171a9f4-b8b5-48a4-ba5a-94b858f7733a.jpg",
  "https://huashangshangmao.top/images/d8260709-608e-45f8-992b-4b609251983e.jpg",
  "https://huashangshangmao.top/images/19c60b97-6913-4c1a-acef-007efcba8fa5.jpg",
  "https://huashangshangmao.top/images/9155fd26-d572-4949-993c-7e266d948eef.jpg",
  "https://huashangshangmao.top/images/a377d550-10b7-4477-8f4c-6db774cecbc8.jpg",
  "https://huashangshangmao.top/images/0e63be0d-34c2-4d12-b5a4-b86675311e4f.jpg",
  "https://huashangshangmao.top/images/d2826b48-e8eb-4f43-ae7b-2fc9c3a15e86.jpg",
  "https://huashangshangmao.top/images/3c38f5ae-3cd0-41f0-8609-b27e8426d642.jpg",
];

const description = `Полный ремкомплект для переборки карбюратора подвесного лодочного мотора 115–130 л.с. (2-тактный, V4 / V6). Аналог штатного ремкомплекта 6E5-W0093-06-00 / 6E5-W0093-06.

СОВМЕСТИМОСТЬ
Совместим с моторами 115–130 л.с. (2-тактные, V4 / V6):
— 115 л.с. (V4, 2T)
— 130 л.с. (V6, 2T)
Подходит к штатным карбюраторам серии 6E5-14301.
ВАЖНО: на этих моторах установлены ДВА карбюратора. Одного комплекта хватает на переборку ОДНОГО карбюратора — для полной переборки мотора заказывайте 2 комплекта.
Перед заказом сверьте номер на корпусе вашего карбюратора — совпадение с 6E5-W0093-06-00 / 6E5-W0093-06 означает полную совместимость.

СОСТАВ КОМПЛЕКТА
— прокладки карбюратора и поплавковой камеры
— мембрана (диафрагма)
— игольчатый клапан с седлом
— поплавок
— жиклёры
— уплотнительные кольца и сальники
— винты и пружины

КРОСС-НОМЕРА (OE)
Ремкомплект: 6E5-W0093-06-00, 6E5-W0093-06
Карбюраторы: серия 6E5-14301
Aftermarket-кросс: 18-7002 (Sierra)

КОГДА НУЖЕН РЕМКОМПЛЕКТ
Перебои на холостом ходу, мотор глохнет, трудный запуск, провалы при разгоне, потеря мощности, растёт расход топлива, подтекание топлива из карбюратора — типичные признаки износа прокладок и игольчатого клапана. Переборка с ремкомплектом возвращает мотору штатную работу.

Установка по штатным размерам, без доработок.
Товар является аналогом по назначению. Номера указаны исключительно для идентификации совместимости.`;

if (/оригинал/i.test(description)) throw new Error("描述含禁词 оригинал*");

const item = {
  offer_id: "MAR-YAM-6E5-01",
  name: TITLE,
  description,
  description_category_id: 17029003,
  type_id: 970861825,
  price: "146.9", old_price: "194.5", vat: "0", currency_code: "CNY",
  images: IMGS,
  depth: 150, width: 120, height: 40, weight: 150,
  attributes: [
    dict(8229, 970861825, "Аксессуары для судов"),
    text(9048, "AMIC-6E5-W0093"),
    dict(85, 126745801, "Нет бренда"),
    dict(10096, 61574, "черный"),
    dict(10400, 970716397, "1 год"),
    dict(4389, 90296, "Китай"),
    text(4180, TITLE),
    text(23171, "#ремкомплекткарбюратора #карбюратор #лодочныймотор #подвесноймотор #запчастилодочныхмоторов #2тактный #115лс #130лс #ремонткарбюратора #прокладкакарбюратора #поплавоккарбюратора #6e5w0093"),
  ],
};

(async () => {
  const r = await ozon("/v3/product/import", { items: [item] });
  console.log("import:", JSON.stringify(r));
  fs.writeFileSync("temp/import-6e5.json", JSON.stringify({ request: { ...item, images: "8 urls" }, response: r }, null, 2));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
