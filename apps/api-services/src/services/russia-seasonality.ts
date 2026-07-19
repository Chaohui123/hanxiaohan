// ============================================================
// Russian Seasonality — local & seasonal demand analysis
// Maps Russian consumer demand by month, holiday, and region.
// ============================================================

// Russian seasonal demand matrix by month
export const RUSSIA_SEASONAL_DEMAND: Record<string, Array<{ keyword: string; category: string; priority: number }>> = {
  "1月": [
    { keyword: "новогодние украшения", category: "Новый год", priority: 95 },
    { keyword: "лыжное снаряжение", category: "Спорт", priority: 85 },
    { keyword: "термобелье", category: "Одежда", priority: 90 },
    { keyword: "увлажнитель воздуха", category: "Бытовая техника", priority: 75 },
    { keyword: "обогреватель", category: "Бытовая техника", priority: 80 },
    { keyword: "зимняя обувь", category: "Обувь", priority: 85 },
  ],
  "2月": [
    { keyword: "подарок на 14 февраля", category: "Подарки", priority: 90 },
    { keyword: "зимняя распродажа", category: "Одежда", priority: 80 },
    { keyword: "автомобильный антифриз", category: "Авто", priority: 70 },
    { keyword: "мужской парфюм", category: "Косметика", priority: 75 },
    { keyword: "шоколадный набор", category: "Подарки", priority: 85 },
  ],
  "3月": [
    { keyword: "подарок на 8 марта", category: "Подарки", priority: 95 },
    { keyword: "весенняя одежда", category: "Одежда", priority: 80 },
    { keyword: "садовый инвентарь", category: "Сад/Дача", priority: 75 },
    { keyword: "кроссовки", category: "Обувь", priority: 80 },
    { keyword: "женская сумка", category: "Аксессуары", priority: 85 },
  ],
  "4月": [
    { keyword: "туристическое снаряжение", category: "Спорт/Туризм", priority: 80 },
    { keyword: "палатка", category: "Спорт/Туризм", priority: 75 },
    { keyword: "велосипедные аксессуары", category: "Спорт", priority: 80 },
    { keyword: "солнечные очки", category: "Аксессуары", priority: 85 },
    { keyword: "дождевик", category: "Одежда", priority: 70 },
  ],
  "5月": [
    { keyword: "мангал", category: "Сад/Дача", priority: 90 },
    { keyword: "садовый инвентарь", category: "Сад/Дача", priority: 85 },
    { keyword: "садовый стол", category: "Сад/Дача", priority: 75 },
    { keyword: "футболка", category: "Одежда", priority: 85 },
    { keyword: "шезлонг", category: "Сад/Дача", priority: 80 },
  ],
  "6月": [
    { keyword: "купальник", category: "Одежда", priority: 90 },
    { keyword: "вентилятор", category: "Бытовая техника", priority: 85 },
    { keyword: "солнцезащитный крем", category: "Косметика", priority: 75 },
    { keyword: "надувной бассейн", category: "Сад/Дача", priority: 80 },
    { keyword: "портативный кондиционер", category: "Бытовая техника", priority: 75 },
  ],
  "7月": [
    { keyword: "игрушки для улицы", category: "Детские товары", priority: 80 },
    { keyword: "чемодан", category: "Аксессуары", priority: 85 },
    { keyword: "формочки для льда", category: "Кухня", priority: 60 },
    { keyword: "сандалии", category: "Обувь", priority: 85 },
    { keyword: "пляжное полотенце", category: "Текстиль", priority: 75 },
  ],
  "8月": [
    { keyword: "школьный рюкзак", category: "Канцтовары", priority: 95 },
    { keyword: "канцелярские товары", category: "Канцтовары", priority: 90 },
    { keyword: "пенал", category: "Канцтовары", priority: 85 },
    { keyword: "осенняя одежда", category: "Одежда", priority: 75 },
    { keyword: "школьная форма", category: "Одежда", priority: 85 },
  ],
  "9月": [
    { keyword: "осенняя куртка", category: "Одежда", priority: 90 },
    { keyword: "зонт", category: "Аксессуары", priority: 80 },
    { keyword: "автомобильное масло", category: "Авто", priority: 70 },
    { keyword: "термос", category: "Кухня", priority: 75 },
    { keyword: "осенние ботинки", category: "Обувь", priority: 85 },
  ],
  "10月": [
    { keyword: "зимняя куртка", category: "Одежда", priority: 85 },
    { keyword: "обогреватель", category: "Бытовая техника", priority: 85 },
    { keyword: "электрический чайник", category: "Бытовая техника", priority: 70 },
    { keyword: "подарок на хэллоуин", category: "Подарки", priority: 65 },
    { keyword: "шерстяной свитер", category: "Одежда", priority: 80 },
  ],
  "11月": [
    { keyword: "черная пятница скидки", category: "Общее", priority: 95 },
    { keyword: "рождественский подарок", category: "Подарки", priority: 90 },
    { keyword: "лыжное снаряжение", category: "Спорт", priority: 80 },
    { keyword: "гирлянда", category: "Декор", priority: 85 },
    { keyword: "елка искусственная", category: "Декор", priority: 85 },
  ],
  "12月": [
    { keyword: "новогодний подарок", category: "Подарки", priority: 100 },
    { keyword: "елочные игрушки", category: "Декор", priority: 95 },
    { keyword: "светодиодная гирлянда", category: "Декор", priority: 90 },
    { keyword: "зимняя шапка", category: "Одежда", priority: 80 },
    { keyword: "варежки", category: "Одежда", priority: 75 },
    { keyword: "подарочная упаковка", category: "Подарки", priority: 85 },
  ],
};

/** Russian public holidays (non-working days) */
export const RUSSIAN_HOLIDAYS: Array<{ date: string; name: string; giftCategory: string }> = [
  { date: "01-01", name: "Новый год", giftCategory: "Подарки" },
  { date: "01-07", name: "Рождество", giftCategory: "Подарки" },
  { date: "02-14", name: "День святого Валентина", giftCategory: "Подарки/Косметика" },
  { date: "02-23", name: "День защитника Отечества", giftCategory: "Подарки/Мужские товары" },
  { date: "03-08", name: "Международный женский день", giftCategory: "Подарки/Косметика/Цветы" },
  { date: "05-01", name: "Праздник Весны и Труда", giftCategory: "Сад/Дача" },
  { date: "05-09", name: "День Победы", giftCategory: "Символика" },
  { date: "06-01", name: "День защиты детей", giftCategory: "Детские товары" },
  { date: "09-01", name: "День знаний", giftCategory: "Канцтовары/Школьные товары" },
  { date: "10-05", name: "День учителя", giftCategory: "Подарки/Канцтовары" },
  { date: "11-04", name: "День народного единства", giftCategory: "Общее" },
  { date: "12-31", name: "Канун Нового года", giftCategory: "Подарки/Декор" },
];

export interface SeasonalDemand {
  month: string;
  monthRu: string;
  categories: Array<{ keyword: string; category: string; priority: number }>;
  upcomingHoliday: { name: string; giftCategory: string } | null;
  season: "winter" | "spring" | "summer" | "autumn";
  score: number; // 0-100 demand intensity
}

/**
 * Get current seasonal demand analysis for Russia.
 * Priority scores are adjusted based on proximity to holidays.
 */
export function getCurrentSeasonDemand(): SeasonalDemand {
  const now = new Date();
  const monthIdx = now.getMonth(); // 0-11
  const monthNum = `${monthIdx + 1}月`;
  const monthNames = [
    "январь", "февраль", "март", "апрель", "май", "июнь",
    "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
  ];

  const categories = RUSSIA_SEASONAL_DEMAND[monthNum] || [];

  // Find nearest upcoming holiday within 14 days
  let upcomingHoliday: { name: string; giftCategory: string } | null = null;
  for (const holiday of RUSSIAN_HOLIDAYS) {
    const [hMonth, hDay] = holiday.date.split("-").map(Number);
    const holidayDate = new Date(now.getFullYear(), hMonth - 1, hDay);
    const diffDays = Math.ceil((holidayDate.getTime() - now.getTime()) / 86400000);
    if (diffDays >= 0 && diffDays <= 14) {
      upcomingHoliday = { name: holiday.name, giftCategory: holiday.giftCategory };
      break;
    }
  }

  // Season
  let season: SeasonalDemand["season"] = "winter";
  if (monthIdx >= 2 && monthIdx <= 4) season = "spring";
  else if (monthIdx >= 5 && monthIdx <= 7) season = "summer";
  else if (monthIdx >= 8 && monthIdx <= 10) season = "autumn";

  // Score: base on category count + holiday proximity bonus
  const baseScore = Math.min(100, categories.length * 12);
  const holidayBonus = upcomingHoliday ? 15 : 0;
  const score = Math.min(100, baseScore + holidayBonus);

  return {
    month: monthNum,
    monthRu: monthNames[monthIdx],
    categories,
    upcomingHoliday,
    season,
    score,
  };
}

/**
 * Check if a specific keyword matches current seasonal demand.
 * Returns seasonal priority score (0-100) or 0 if no match.
 */
export function getSeasonalMatchScore(keyword: string): number {
  const demand = getCurrentSeasonDemand();
  const lowerKeyword = keyword.toLowerCase();
  for (const cat of demand.categories) {
    if (lowerKeyword.includes(cat.keyword.toLowerCase()) || cat.keyword.toLowerCase().includes(lowerKeyword)) {
      return cat.priority;
    }
  }
  return 0; // No seasonal match
}
