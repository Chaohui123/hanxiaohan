// 化油器修理包建品 MAR-YAM-66T-01（61N 同族结构；文案 copy-carb-66t.md；红线：标题/标签零品牌词）
const fs = require("fs");
const { ozon } = require("./ozon-api.cjs");

const dict = (id, did, value) => ({ complex_id: 0, id, values: [{ dictionary_value_id: did, value }] });
const text = (id, value) => ({ complex_id: 0, id, values: [{ value }] });

const TITLE = "Ремкомплект карбюратора 40 л.с. 2T, аналог 66T-W0093-00 / 66T-W0093-01";
if (TITLE.length > 100) throw new Error("标题超 100 字符");

const IMGS = [
  "https://huashangshangmao.top/images/e78cc885-40ae-49a4-9d2a-baaebc33b500.jpg",
  "https://huashangshangmao.top/images/4f4cf311-fac1-49c8-926f-34446a4d6b5f_opt.jpg",
  "https://huashangshangmao.top/images/0d573db8-f91e-4f3c-bbcc-a44dc4a8a05b.jpg",
  "https://huashangshangmao.top/images/25af61cb-6c7d-463a-8e15-6e4d0f7d567e.jpg",
  "https://huashangshangmao.top/images/f0b8784f-af89-4048-ae19-f778fced2b5e.jpg",
  "https://huashangshangmao.top/images/86f31f09-70d8-46b0-aab0-3e459d88e889.jpg",
  "https://huashangshangmao.top/images/e2176d89-253b-45e4-9823-f857c0c11803.jpg",
  "https://huashangshangmao.top/images/f19bb727-12fa-43a0-a704-9b6e9a1cd6cc.jpg",
];

const description = `Полный ремкомплект для переборки карбюратора подвесного лодочного мотора 40 л.с. (2-тактный). Аналог штатного ремкомплекта 66T-W0093-00 / 66T-W0093-01.

СОВМЕСТИМОСТЬ
Совместим с моторами Yamaha (2T, 40 л.с.):
— 40X (2-тактный, 40 л.с.)
— E40X / E40XM / E40XMH (2-тактный, 40 л.с.)
Подходит к штатным карбюраторам: 66T-14301-00, 66T-14301-01, 66T-14301-02.
Перед заказом сверьте номер на корпусе вашего карбюратора — совпадение с 66T-W0093-00/01 означает полную совместимость.

СОСТАВ КОМПЛЕКТА
— прокладки карбюратора и поплавковой камеры
— мембрана (диафрагма)
— игольчатый клапан с седлом
— поплавок
— жиклёры
— уплотнительные кольца и сальники
— винты и пружины

КРОСС-НОМЕРА (OE)
Ремкомплект: 66T-W0093-00, 66T-W0093-01
Карбюраторы: 66T-14301-00, 66T-14301-01, 66T-14301-02

КОГДА НУЖЕН РЕМКОМПЛЕКТ
Перебои на холостом ходу, мотор глохнет, трудный запуск, растёт расход топлива, подтекание топлива из карбюратора — типичные признаки износа прокладок и игольчатого клапана. Переборка с ремкомплектом возвращает мотору штатную работу.

Установка по штатным размерам, без доработок.
Товар является аналогом (не оригинальная запчасть). Номера указаны исключительно для идентификации совместимости.`;

const item = {
  offer_id: "MAR-YAM-66T-01",
  name: TITLE,
  description,
  description_category_id: 17029003,
  type_id: 970861825,
  price: "146.9", old_price: "190.4", vat: "0", currency_code: "CNY",
  images: IMGS,
  depth: 150, width: 120, height: 40, weight: 150,
  attributes: [
    dict(8229, 970861825, "Аксессуары для судов"),
    text(9048, "AMIC-66T-W0093"),
    dict(85, 126745801, "Нет бренда"),
    dict(10096, 61574, "черный"),
    dict(10400, 970716397, "1 год"),
    dict(4389, 90296, "Китай"),
    text(4180, TITLE),
    text(23171, "#ремкомплекткарбюратора #ремкомплект #карбюратор #лодочныймотор #подвесноймотор #запчастилодочныхмоторов #2тактный #40лс #ремонткарбюратора #прокладкакарбюратора #поплавоккарбюратора #66tw0093"),
  ],
};

(async () => {
  const r = await ozon("/v3/product/import", { items: [item] });
  console.log("import:", JSON.stringify(r));
  fs.writeFileSync("temp/import-66t.json", JSON.stringify({ request: { ...item, images: "8 urls" }, response: r }, null, 2));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
