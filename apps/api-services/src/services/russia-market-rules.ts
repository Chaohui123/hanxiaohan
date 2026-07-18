export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'forbidden';

export interface CategoryRule {
  category: string;
  keywords: string[];
  riskLevel: RiskLevel;
  description: string;
  restrictions?: string[];
  alternatives?: string[];
}

export interface LogisticsRisk {
  type: string;
  riskLevel: RiskLevel;
  description: string;
  recommendations: string[];
}

export interface MarketAnalysis {
  isForbidden: boolean;
  isRestricted: boolean;
  isLogisticsRisk: boolean;
  isHighDemand: boolean;
  demandLevel: 'none' | 'low' | 'medium' | 'high' | 'very_high';
  complianceScore: number;
  logisticsScore: number;
  marketScore: number;
  overallScore: number;
  warnings: string[];
  recommendations: string[];
  riskTags: string[];
}

export interface SeasonalInfo {
  currentSeason: string;
  peakCategories: string[];
  seasonalScore: number;
  recommendations: string[];
}

export interface AutoPartAnalysis {
  matchKeywords: string[];
  isAutoPart: boolean;
  demandPotential: number;
  diyFriendliness: number;
  marketReadiness: number;
  autoCategory: string | null;
  score: number;
}

const FORBIDDEN_PRODUCTS: CategoryRule[] = [
  { category: '武器弹药', keywords: ['武器', '枪支', '弹药', '子弹', '刀具', '匕首', '弹簧刀', '电击', '辣椒水', '警棍'], riskLevel: 'forbidden', description: '俄罗斯严格禁止武器类产品进口' },
  { category: '烟草制品', keywords: ['香烟', '烟草', '雪茄', '电子烟', '烟油', '尼古丁', '烟具', '加热不燃烧', 'iqos'], riskLevel: 'forbidden', description: '跨境电商禁止销售烟草和电子烟产品' },
  { category: '药品保健品', keywords: ['药品', '药丸', '胶囊', '处方药', '非处方药', 'otc', '保健品', '膳食补充', '壮阳', '减肥', '伟哥', '希爱力', '用药'], riskLevel: 'forbidden', description: '药品需要俄罗斯认证，个人进口限制严格' },
  { category: '色情内容', keywords: ['色情', '成人', '性爱', '情趣内衣', '性玩具', '震动', '娃娃', '充气'], riskLevel: 'forbidden', description: '成人用品在俄罗斯有严格限制' },
  { category: '活物和食品', keywords: ['活体', '宠物', '食品', '食物', '零食', '饮料', '奶粉', '肉类', '奶制品', '新鲜', '水果', '蔬菜', '狗粮', '猫粮'], riskLevel: 'forbidden', description: '食品和活体需要特殊检疫' },
  { category: '贵金属和货币', keywords: ['黄金', '白银', '铂金', '金币', '银币', '纪念币', '纸币', '货币', '证券', '邮票'], riskLevel: 'forbidden', description: '贵金属和货币类产品需要特殊许可' },
  { category: '珠宝首饰(远程禁售)', keywords: ['钻石', '祖母绿', '红宝石', '蓝宝石', '宝石首饰', '金首饰', '铂金首饰'], riskLevel: 'forbidden', description: '含宝石/贵金属的首饰禁止跨境远程销售' },
  { category: 'AI深度伪造硬件', keywords: ['深度伪造', 'deepfake', '换脸', 'ai造假'], riskLevel: 'forbidden', description: '2024年俄罗斯新增禁止AI深度伪造内容硬件' },
];

const HIGH_RISK_PRODUCTS: CategoryRule[] = [
  { category: '带电产品', keywords: ['电池', '锂电池', '充电宝', '移动电源', '电动', '剃须刀', '电动牙刷', '电动工具', '充电钻'], riskLevel: 'high', description: '含锂电池产品需要特殊物流通道，成本高', restrictions: ['需提供MSDS认证', '限制空运', '需特殊包装'], alternatives: ['选择不含电池的版本', '使用俄罗斯本地发货'] },
  { category: '液体产品', keywords: ['液体', '水剂', '油', '乳液', '面霜', '香水', '洗涤剂', '清洁剂', '精油', '化妆水'], riskLevel: 'high', description: '液体产品运输受限且容易泄漏', restrictions: ['限制空运', '需特殊密封包装', '可能被海关抽查'], alternatives: ['选择固体/粉状替代品', '使用俄罗斯本地仓'] },
  { category: '易碎品', keywords: ['玻璃', '陶瓷', '瓷器', '工艺品', '易碎', '水晶', '镜片', '相框', '灯泡'], riskLevel: 'high', description: '易碎品运输破损率高，售后成本大', restrictions: ['需要加固包装', '建议购买运输保险', '破损率通常5-15%'], alternatives: ['选择非易碎材质', '使用厚泡沫包装', '本地仓发货'] },
  { category: '大型重货', keywords: ['家具', '沙发', '桌子', '床', '床垫', '柜子', '大型', '大件'], riskLevel: 'high', description: '大件商品物流成本高，清关复杂', restrictions: ['海运/陆运为主', '配送时间长', '运费可能超过货值'], alternatives: ['选择小体积产品', '与本地供应商合作'] },
  { category: '品牌仿品', keywords: ['耐克', 'nike', '阿迪', 'adidas', '苹果', 'iphone', '路易威登', 'lv', '古驰', 'gucci', '香奈儿', '仿品', '复刻', '同款'], riskLevel: 'high', description: '俄罗斯对知识产权保护严格', restrictions: ['100%查验风险', '可能被罚款', '店铺可能被封禁'], alternatives: ['销售自主品牌', '选择无品牌商品', '选择授权品牌'] },
  { category: '医疗设备', keywords: ['口罩', '医用', '体温计', '血压计', '血糖仪', '治疗仪', '保健器械'], riskLevel: 'medium', description: '医疗类产品需要认证' },
  { category: '磁性产品', keywords: ['磁铁', '磁性', '磁石', '磁力', '磁疗', '磁性玩具'], riskLevel: 'medium', description: '磁性产品空运受限' },
  { category: '化学品', keywords: ['化学品', '化学', '试剂', '涂料', '油漆', '胶水', '粘合剂', '指甲油'], riskLevel: 'medium', description: '化学品需要特殊审批' },
  { category: '高压容器', keywords: ['喷雾', '气雾剂', '高压', '气瓶', '液化气', '喷罐', '打火机', '充气'], riskLevel: 'medium', description: '高压容器类产品运输风险高' },
  // 2024年6月Ozon新增中国跨境店限制
  { category: 'Ozon限制-电子产品(2024.6)', keywords: ['手机', '笔记本电脑', '笔记本', '充电器', '平板电脑', '平板', '电脑', '显示器', '电视', '智能手表', '手环', '耳机', '蓝牙耳机', '无线耳机'], riskLevel: 'high', description: '2024年6月26日起Ozon限制中国跨境店销售电子产品', restrictions: ['需提前确认类目是否开放', '可能需要俄罗斯本地仓发货'], alternatives: ['转向家居日用、儿童用品、宠物用品', '超小件商品利用低成本物流'] },
  { category: 'Ozon限制-汽车摩配(2024.6)', keywords: ['汽车配件', '汽车', '摩托', '摩托车配件', '汽配', '机油', '滤清器', '刹车片', '火花塞', '轮胎', '车载', '行车记录仪', '车充', 'DIY工具', '电动工具', '扳手', '螺丝刀', '电钻'], riskLevel: 'high', description: '2024年6月26日起Ozon限制中国跨境店销售汽车摩配和DIY工具', restrictions: ['汽配和工具类目全面受限'], alternatives: ['时尚、家居日用、儿童用品、宠物用品'] },
];

const LOW_RISK_PRODUCTS: CategoryRule[] = [
  { category: '超重产品', keywords: ['20kg', '30kg', '40kg', '50kg', '重'], riskLevel: 'low', description: '超重商品会增加物流费用' }
];

export interface CategoryDemandConfig {
  category: string;
  keywords: string[];
  demandScore: number;
  seasonality?: number[];
  diyPotential?: number;
  description?: string;
  avgProfitMargin?: number;
}

const RUSSIA_HIGH_DEMAND_CATEGORIES: CategoryDemandConfig[] = [
  { category: '冬季服装', keywords: ['羽绒服', '棉衣', '保暖', '冬装', '外套', '大衣', '毛衣', '羊毛', '保暖内衣', '防寒', '冬裤'], demandScore: 95, seasonality: [9, 10, 11, 12, 1, 2, 3], description: '俄罗斯冬季严寒，刚需巨大', avgProfitMargin: 0.35 },
  { category: '鞋子靴子', keywords: ['雪地靴', '靴子', '棉鞋', '马丁靴', '运动鞋', '跑鞋', '板鞋', '皮鞋', '登山鞋', '防水鞋'], demandScore: 90, description: '冬季必备，市场需求稳定', avgProfitMargin: 0.3 },
  { category: '汽车配件', keywords: ['汽车', '车载', '车充', '行车记录仪', '脚垫', '座套', '方向盘', '汽车配件', '机油', '滤清器', '刹车片', '火花塞', '灯泡', '轮胎', '雨刷', '内饰', '空调滤芯', '空气滤芯', '工具', '扳手', '套筒', '千斤顶', '应急', '搭电线', '拖车绳', '充气泵', '吸尘器', '清洁剂', '防冻液', '玻璃水', '座椅套', '方向盘套', '挡泥板', '护板', '车衣', '遮阳'], demandScore: 95, diyPotential: 90, description: '俄罗斯汽车保有量大，DIY维修文化盛行', avgProfitMargin: 0.4 },
  { category: '家居用品', keywords: ['家居', '收纳', '收纳盒', '收纳袋', '厨房', '餐具', '厨具', '清洁', '扫把', '拖把', '垃圾桶', '置物架', '挂钩', '衣架', '洗衣', '熨烫', '纸巾盒'], demandScore: 85, description: '俄式住宅特点，收纳需求大', avgProfitMargin: 0.35 },
  { category: '手机配件', keywords: ['手机壳', '保护套', '钢化膜', '充电器', '数据线', '耳机', '支架', '充电宝', '移动电源', '蓝牙', '无线充电', '手机支架'], demandScore: 88, description: '电子产品渗透率高，复购强', avgProfitMargin: 0.3 },
  { category: '电子产品', keywords: ['耳机', '蓝牙', '音响', '音箱', '鼠标', '键盘', '平板', '笔记本', '摄像头', '智能手表', '手环', '读卡器', 'U盘', '硬盘'], demandScore: 80, avgProfitMargin: 0.25 },
  { category: '工具五金', keywords: ['工具', '螺丝刀', '扳手', '电钻', '五金', '维修', '工具套装', '钳子', '锤子', '锯', '卷尺', '美工刀', '螺丝', '膨胀螺丝', '免钉胶', '密封胶'], demandScore: 85, diyPotential: 95, description: '俄罗斯人热衷DIY维修', avgProfitMargin: 0.4 },
  { category: '户外用品', keywords: ['户外', '帐篷', '睡袋', '登山', '钓鱼', '野营', '烧烤', '折叠', '露营', '野餐', '保温', '冰桶', '户外灯'], demandScore: 70, seasonality: [5, 6, 7, 8], description: '夏季户外活动旺季', avgProfitMargin: 0.35 },
  { category: '母婴用品', keywords: ['婴儿', '宝宝', '儿童', '玩具', '尿不湿', '奶瓶', '婴儿车', '童装', '学步', '益智', '积木'], demandScore: 75, avgProfitMargin: 0.3 },
  { category: '美妆工具', keywords: ['化妆刷', '美妆蛋', '睫毛夹', '化妆工具', '美容仪', '梳子', '镜子', '美甲', '美甲工具', '指甲油胶'], demandScore: 70, avgProfitMargin: 0.35 },
  { category: '文具办公', keywords: ['文具', '笔记本', '笔', '文件夹', '办公', '胶带', '便签', '订书机', '剪刀', '回形针', '计算器'], demandScore: 60, seasonality: [8, 9], description: '返校季需求旺盛', avgProfitMargin: 0.25 },
  { category: '宠物用品', keywords: ['宠物', '狗', '猫', '狗窝', '猫砂', '宠物玩具', '牵引绳', '项圈', '宠物服装', '饮水器', '食盆'], demandScore: 75, description: '俄罗斯宠物饲养率高', avgProfitMargin: 0.3 },
  { category: '运动健身', keywords: ['运动', '健身', '瑜伽', '跑步', '哑铃', '健身器材', '运动服', '健身服', '健身手套', '瑜伽垫', '拉力带', '跳绳'], demandScore: 70, avgProfitMargin: 0.3 },
  { category: '厨房小家电', keywords: ['电饭煲', '电热水壶', '豆浆机', '榨汁机', '咖啡机', '面包机', '烤箱', '微波炉', '电蒸锅', '空气炸锅', '料理机'], demandScore: 80, avgProfitMargin: 0.25 },
  { category: '装饰品', keywords: ['装饰', '摆件', '装饰画', '壁画', '墙贴', '灯饰', '挂件', '节日装饰', '新年装饰', '圣诞'], demandScore: 65, seasonality: [11, 12, 1], avgProfitMargin: 0.35 },
  { category: 'LED照明', keywords: ['led', '灯泡', '灯具', '照明', '灯带', '灯条', '吸顶灯', '台灯', '落地灯', '小夜灯', '投影灯'], demandScore: 82, description: '俄罗斯重视节能照明', avgProfitMargin: 0.35 },
  { category: '冬季用品', keywords: ['保暖', '手套', '帽子', '围巾', '耳罩', '暖宝宝', '暖贴', '电热毯', '热水袋', '保温瓶', '保温杯', '保温壶'], demandScore: 90, seasonality: [10, 11, 12, 1, 2, 3], description: '冬季取暖必需品', avgProfitMargin: 0.35 },
  { category: '新年节日用品', keywords: ['新年', '圣诞树', '圣诞装饰', '礼物', '礼品', '新年装饰', '雪花', '彩带', '气球', '派对', '元旦'], demandScore: 85, seasonality: [11, 12, 1], avgProfitMargin: 0.4 },
  { category: '汽车应急', keywords: ['应急', '搭电', '拖车', '急救', '安全锤', '灭火器', '反光', '三角警示牌', '补胎', '车载应急', '应急包', '救生'], demandScore: 88, diyPotential: 95, description: '俄罗斯车主常备应急物品', avgProfitMargin: 0.4 },
  { category: '汽车保养', keywords: ['机油', '滤清器', '滤芯', '刹车片', '火花塞', '雨刷', '玻璃水', '防冻液', '冷却液', '轮胎', '气压表', '清洁剂', '洗车', '保养', '润滑', '除锈'], demandScore: 92, diyPotential: 98, description: '80%俄罗斯车主自己做常规保养', avgProfitMargin: 0.4 },
  { category: '汽车内饰', keywords: ['脚垫', '座套', '座椅套', '方向盘套', '头枕', '腰靠', '香水', '挂件', '装饰', '收纳盒', '手机支架', '杯架', '遮阳挡', '窗帘'], demandScore: 85, diyPotential: 90, description: '汽车内饰个性化需求大', avgProfitMargin: 0.35 },
  { category: '家庭维修', keywords: ['密封胶', '玻璃胶', '免钉胶', '螺丝', '膨胀', '胶带', '防水', '修补', '维修', '油漆', '涂料', '粘合剂', '填缝', '堵漏'], demandScore: 88, diyPotential: 98, description: '俄罗斯家庭普遍自己维修', avgProfitMargin: 0.4 },
  { category: '电工用品', keywords: ['电线', '开关', '插座', '插头', '接线', '绝缘', '电胶布', '漏电', '保险丝', '灯泡', '灯具', '电工'], demandScore: 82, diyPotential: 90, description: '家庭电气维修常用', avgProfitMargin: 0.35 },
  { category: '水暖卫浴', keywords: ['水龙头', '花洒', '水管', '接头', '角阀', '地漏', '卫浴', '浴室', '淋浴', '马桶', '配件', '密封圈', '生料带'], demandScore: 80, diyPotential: 92, description: '卫浴维修需求大', avgProfitMargin: 0.35 },
  { category: '清洁用品', keywords: ['清洁剂', '去污', '消毒', '清洁布', '抹布', '海绵', '拖把', '扫把', '清洁工具', '洗衣', '洗碗', '玻璃清洁'], demandScore: 85, avgProfitMargin: 0.3 },
  { category: '节日礼品', keywords: ['礼品', '礼物', '情人节', '妇女节', '新年', '生日', '节日', '礼盒', '贺卡', '礼品盒', '包装'], demandScore: 75, seasonality: [1, 2, 3, 11, 12], avgProfitMargin: 0.4 }
];

export interface AutoPartCategory {
  category: string;
  keywords: string[];
  avgProfit: number;
  diyDifficulty: number;
  marketSize: number;
  competitiveness: number;
  seasonality?: number[];
  description: string;
}

const AUTO_PART_CATEGORIES: AutoPartCategory[] = [
  { category: '常规保养用品', keywords: ['机油', '润滑油', '滤清器', '滤芯', '空气滤芯', '空调滤芯', '机油滤芯', '燃油滤芯', '火花塞', '刹车片', '刹车油', '变速箱油', '防冻液', '冷却液', '玻璃水', '雨刷', '雨刮', '雨刮片', '雨刷片'], avgProfit: 35, diyDifficulty: 20, marketSize: 95, competitiveness: 70, description: '常规保养耗材，DIY友好，高频复购' },
  { category: '汽车电子', keywords: ['行车记录仪', '车充', '车载充电器', '蓝牙', '车载蓝牙', 'GPS', '导航', '倒车雷达', '倒车影像', '胎压监测', '汽车灯泡', 'LED灯', '大灯', '雾灯', '示宽灯', '阅读灯', '氛围灯', '点烟器', 'USB充电器'], avgProfit: 40, diyDifficulty: 30, marketSize: 85, competitiveness: 75, description: '汽车电子加装，多数可自行安装' },
  { category: '汽车内饰', keywords: ['脚垫', '地毯', '座套', '座椅套', '方向盘套', '头枕', '腰靠', '靠垫', '汽车香水', '挂件', '挂饰', '装饰', '遮阳挡', '遮阳板', '车窗帘', '收纳盒', '置物盒', '手机支架', '车载支架', '杯架', '储物', '收纳袋', '后备箱垫'], avgProfit: 45, diyDifficulty: 10, marketSize: 90, competitiveness: 65, description: '内饰装饰用品，安装简单，利润高' },
  { category: '汽车外观', keywords: ['车衣', '车罩', '挡泥板', '挡泥皮', '护板', '底盘护甲', '晴雨挡', '雨眉', '车窗饰条', '车门防撞', '防撞条', '门碗', '拉手', '装饰条', '亮条', '车标', '贴纸', '车贴'], avgProfit: 42, diyDifficulty: 25, marketSize: 75, competitiveness: 70, description: '外观装饰件，DIY安装可行' },
  { category: '应急救援', keywords: ['应急包', '急救包', '搭电线', '电瓶线', '过江龙', '拖车绳', '拖车带', '千斤顶', '车用千斤顶', '液压', '安全锤', '逃生锤', '灭火器', '车载灭火器', '三角警示牌', '反光背心', '补胎工具', '应急灯', '警示灯', '胎压表', '充气泵', '车载充气泵'], avgProfit: 45, diyDifficulty: 15, marketSize: 88, competitiveness: 55, description: '车主常备应急物品，刚需强' },
  { category: '维修工具', keywords: ['扳手', '套筒', '工具套装', '棘轮扳手', '扭矩扳手', '螺丝刀', '起子', '钳子', '老虎钳', '尖嘴钳', '锤子', '榔头', '卷尺', '美工刀', '电钻', '充电钻', '多功能工具'], avgProfit: 50, diyDifficulty: 30, marketSize: 85, competitiveness: 60, description: '维修工具套装，俄罗斯DIY文化盛行' },
  { category: '清洁养护', keywords: ['洗车液', '车蜡', '镀晶', '镀膜', '清洁剂', '内饰清洁剂', '皮革护理', '轮胎蜡', '轮胎光亮剂', '洗车海绵', '洗车毛巾', '擦车布', '拖把', '洗车工具', '水桶', '高压水枪', '吸尘器', '车载吸尘器', '除味剂', '空气清新'], avgProfit: 40, diyDifficulty: 10, marketSize: 88, competitiveness: 60, description: '洗车养护用品，高频复购' },
  { category: '轮胎相关', keywords: ['轮胎', '车胎', '内胎', '气门嘴', '气门芯', '胎压', '胎压监测', '补胎', '补胎液', '补胎胶', '防滑链', '雪地链', '轮胎螺栓', '轮毂', '轮圈'], avgProfit: 35, diyDifficulty: 60, marketSize: 80, competitiveness: 70, seasonality: [9, 10, 11, 3, 4], description: '轮胎相关，季节更换需求' },
  { category: '空调系统', keywords: ['空调滤芯', '冷气格', '空调滤清器', '冷媒', '制冷剂', '氟利昂', '空调清洗', '空调消毒', '蒸发器', '冷凝器', '鼓风机'], avgProfit: 38, diyDifficulty: 35, marketSize: 75, seasonality: [5, 6, 7, 8], competitiveness: 55, description: '空调保养，夏季旺季' },
  { category: '电气系统', keywords: ['电瓶', '蓄电池', '保险丝', '保险片', '继电器', '开关', '按钮', '电线', '线束', '连接器', '插头', '插座', '电压转换器', '逆变器', '变压器'], avgProfit: 42, diyDifficulty: 40, marketSize: 70, competitiveness: 50, description: '电气配件，部分可自行更换' },
  { category: '油品添加剂', keywords: ['燃油宝', '汽油添加剂', '柴油添加剂', '发动机清洗剂', '油路清洗', '积碳清除', '机油添加剂', '抗磨剂', '修复剂', '发动机修复', '密封件'], avgProfit: 55, diyDifficulty: 15, marketSize: 80, competitiveness: 65, description: '油品添加剂，利润率高，使用简单' },
  { category: '外饰改装', keywords: ['大灯', '尾灯', '雾灯', '转向灯', '灯泡', 'LED大灯', '氙气灯', '后视镜', '倒车镜', '雨刮臂', '雨刮器', '喷水嘴', '玻璃', '车窗'], avgProfit: 40, diyDifficulty: 50, marketSize: 70, competitiveness: 70, description: '外饰件更换，中等DIY难度' }
];

export function getSeasonalInfo(month?: number): SeasonalInfo {
  const m = month ?? new Date().getMonth() + 1;
  
  let season: string;
  let peakCategories: string[] = [];
  let seasonalScore: number;
  
  if (m >= 11 || m <= 2) {
    season = '冬季';
    peakCategories = ['冬季服装', '鞋子靴子', '冬季用品', '新年节日用品', '汽车保养', '轮胎相关'];
    seasonalScore = 95;
  } else if (m >= 3 && m <= 5) {
    season = '春季';
    peakCategories = ['春季服装', '户外用品', '文具办公', '汽车保养', '清洁用品'];
    seasonalScore = 70;
  } else if (m >= 6 && m <= 8) {
    season = '夏季';
    peakCategories = ['夏季服装', '户外用品', '空调系统', '清凉用品', '户外运动'];
    seasonalScore = 75;
  } else {
    season = '秋季';
    peakCategories = ['秋季服装', '冬季服装准备', '鞋子靴子', '冬季用品', '汽车保养'];
    seasonalScore = 85;
  }

  const recommendations: string[] = [
    `当前为${season}(${m}月)，重点关注：${peakCategories.slice(0, 3).join('、')}`,
    `季节热度评分：${seasonalScore}/100`,
    peakCategories.length > 3 ? `其他潜力品类：${peakCategories.slice(3).join('、')}` : ''
  ].filter(Boolean);

  return {
    currentSeason: season,
    peakCategories,
    seasonalScore,
    recommendations
  };
}

export function analyzeAutoParts(title: string, description: string = ''): AutoPartAnalysis {
  const content = `${title} ${description}`.toLowerCase();
  let matchedCategory: AutoPartCategory | null = null;
  const matchKeywords: string[] = [];

  for (const cat of AUTO_PART_CATEGORIES) {
    const hits = cat.keywords.filter(k => content.includes(k.toLowerCase()));
    if (hits.length > 0) {
      matchKeywords.push(...hits);
      if (!matchedCategory || hits.length > 2) {
        matchedCategory = cat;
      }
    }
  }

  const isAutoPart = matchKeywords.length > 0;
  
  let demandPotential = 50;
  let diyFriendliness = 50;
  let marketReadiness = 50;
  let score = 50;

  if (isAutoPart && matchedCategory) {
    demandPotential = matchedCategory.marketSize;
    diyFriendliness = 100 - matchedCategory.diyDifficulty;
    marketReadiness = Math.round((100 - matchedCategory.competitiveness) * 0.7 + demandPotential * 0.3);
    
    score = Math.round(
      demandPotential * 0.35 +
      diyFriendliness * 0.25 +
      matchedCategory.avgProfit * 0.25 +
      marketReadiness * 0.15
    );
  }

  return {
    matchKeywords: Array.from(new Set(matchKeywords)).slice(0, 5),
    isAutoPart,
    demandPotential,
    diyFriendliness,
    marketReadiness,
    autoCategory: matchedCategory?.category || null,
    score
  };
}

export function analyzeCompliance(title: string, description: string = '', categoryPath: string[] = []
): { forbidden: CategoryRule[]; highRisk: CategoryRule[]; mediumRisk: CategoryRule[] } {
  const content = `${title} ${description} ${categoryPath.join(' ')}`.toLowerCase();

  const checkRules = (rules: CategoryRule[]): CategoryRule[] => {
    return rules.filter(rule => rule.keywords.some(keyword => content.includes(keyword.toLowerCase())));
  };

  // Async RAG enrichment (can be awaited separately)
  enrichWithRag(title, description, categoryPath.join(' ')).catch(() => {});

  return {
    forbidden: checkRules(FORBIDDEN_PRODUCTS),
    highRisk: checkRules(HIGH_RISK_PRODUCTS),
    mediumRisk: checkRules(LOW_RISK_PRODUCTS)
  };
}

/**
 * Query RAG knowledge base for Ozon compliance rules matching the product.
 * This supplements the hardcoded rules with the latest policy updates.
 */
async function enrichWithRag(title: string, description: string, categoryPath: string): Promise<void> {
  try {
    const db = await (async () => {
      const { getDb } = await import("../db/connection.js");
      return getDb().catch(() => null);
    })();
    if (!db) return;

    const query = `${title} ${description} ${categoryPath}`.slice(0, 300);
    const rows = await db.all<{ title: string; content: string; tags: string }>(
      `SELECT title, content, tags FROM rag_operations_playbook
       WHERE scenario = 'compliance'
       AND (content LIKE '%' || ? || '%' OR tags LIKE '%' || ? || '%')
       LIMIT 3`,
      [query.slice(0, 50), query.slice(0, 30)]
    ).catch(() => [] as Array<{ title: string; content: string; tags: string }>);

    if (rows.length > 0) {
      const { logger } = await import("@onzo/logger");
      logger.info({ matchCount: rows.length, titles: rows.map(r => r.title) },
        "RAG: compliance rules matched for product");
    }
  } catch { /* RAG unavailable — non-blocking */ }
}

/**
 * Query RAG for compliance context — returns formatted text for AI prompts.
 * Used by listing pipeline and promo copywriter for context injection.
 */
export async function queryRagCompliance(title: string, description: string = ""): Promise<string> {
  try {
    const db = await (async () => {
      const { getDb } = await import("../db/connection.js");
      return getDb().catch(() => null);
    })();
    if (!db) return "";

    const query = `${title} ${description}`.slice(0, 200);
    const rows = await db.all<{ title: string; content: string }>(
      `SELECT title, substr(content, 1, 500) as content FROM rag_operations_playbook
       WHERE scenario = 'compliance' AND (
         content LIKE '%' || ? || '%'
         OR content LIKE '%认证%'
         OR content LIKE '%EAC%'
         OR tags LIKE '%合规%'
       )
       ORDER BY priority DESC LIMIT 5`,
      [query.slice(0, 40)]
    ).catch(() => [] as Array<{ title: string; content: string }>);

    if (rows.length === 0) return "";
    return rows.map((r) => `[${r.title}]: ${r.content}`).join("\n\n");
  } catch {
    return "";
  }
}

export function analyzeLogisticsRisk(title: string, description: string = '', weightKg: number = 0.5
): LogisticsRisk[] {
  const risks: LogisticsRisk[] = [];
  const content = `${title} ${description}`.toLowerCase();

  if (weightKg > 20) {
    risks.push({ type: '超重', riskLevel: 'high', description: `商品重量${weightKg}kg，运费大幅增加`, recommendations: ['考虑海运/陆运', '拆分包裹', '评估运费是否仍有利润空间'] });
  } else if (weightKg > 10) {
    risks.push({ type: '重量偏大', riskLevel: 'medium', description: `商品重量${weightKg}kg，运费较高`, recommendations: ['注意包装尺寸', '比较不同物流渠道'] });
  }

  const fragileKeywords = ['玻璃', '陶瓷', '易碎', '水晶', '镜片'];
  if (fragileKeywords.some(k => content.includes(k))) {
    risks.push({ type: '易碎品', riskLevel: 'high', description: '包含易碎材质，运输破损风险高', recommendations: ['使用加厚泡沫包装', '考虑购买运输保险', '破损率通常5-15%'] });
  }

  const liquidKeywords = ['液体', '乳液', '油', '香水', '水剂', '液'];
  if (liquidKeywords.some(k => content.includes(k))) {
    risks.push({ type: '液体', riskLevel: 'high', description: '含液体成分，空运受限且易泄漏', recommendations: ['检查液体类型是否允许运输', '使用密封包装', '考虑本地仓发货'] });
  }

  const batteryKeywords = ['电池', '锂电池', '充电', '电动', '充电宝', '移动电源', '锂电'];
  if (batteryKeywords.some(k => content.includes(k))) {
    risks.push({ type: '含电池', riskLevel: 'high', description: '含锂电池产品，空运受限且需要特殊处理', recommendations: ['提供MSDS认证', '选择特殊物流渠道', '成本可能增加30-50%'] });
  }

  const magnetKeywords = ['磁铁', '磁性', '磁石', '磁力'];
  if (magnetKeywords.some(k => content.includes(k))) {
    risks.push({ type: '磁性产品', riskLevel: 'medium', description: '含磁性材料，可能影响航空安全', recommendations: ['使用防磁包装', '选择非空运渠道'] });
  }

  const chemicalKeywords = ['化学', '涂料', '油漆', '胶水', '粘合剂', '试剂'];
  if (chemicalKeywords.some(k => content.includes(k))) {
    risks.push({ type: '化学品', riskLevel: 'high', description: '含化学品，需要特殊审批', recommendations: ['确认成分合规性', '准备安全数据表'] });
  }

  const largeKeywords = ['大型', '大件', '家具', '沙发', '床', '柜子'];
  if (largeKeywords.some(k => content.includes(k)) || weightKg > 30) {
    risks.push({ type: '大件商品', riskLevel: 'high', description: '体积大或重量大，运输成本高', recommendations: ['评估运输成本占比', '考虑本地组装', '海运更经济'] });
  }

  if (risks.length === 0) {
    risks.push({ type: '常规商品', riskLevel: 'safe', description: '该商品无特殊运输限制，适合跨境销售', recommendations: ['标准包装即可', '选择经济物流渠道'] });
  }

  return risks;
}

export function analyzeMarketDemand(title: string, description: string = '', categoryPath: string[] = []
): { demandLevel: number; matchedCategories: string[]; isHighDemand: boolean; seasonalInfo?: SeasonalInfo; matchedDetails: CategoryDemandConfig[] } {
  const content = `${title} ${description} ${categoryPath.join(' ')}`.toLowerCase();
  let highestDemand = 0;
  const matchedCategories: string[] = [];
  const matchedDetails: CategoryDemandConfig[] = [];

  const seasonal = getSeasonalInfo();
  
  for (const cat of RUSSIA_HIGH_DEMAND_CATEGORIES) {
    const hits = cat.keywords.filter(k => content.includes(k.toLowerCase()));
    if (hits.length > 0) {
      matchedCategories.push(cat.category);
      matchedDetails.push(cat);
      
      let score = cat.demandScore;
      if (cat.seasonality && cat.seasonality.includes(new Date().getMonth() + 1)) {
        score = Math.min(100, score + 15);
      }
      if (seasonal.peakCategories.includes(cat.category)) {
        score = Math.min(100, score + 10);
      }
      if (score > highestDemand) {
        highestDemand = score;
      }
    }
  }

  return {
    demandLevel: highestDemand,
    matchedCategories,
    isHighDemand: highestDemand >= 60,
    seasonalInfo: seasonal,
    matchedDetails
  };
}

export function analyzeProductForRussia(title: string, description: string = '', categoryPath: string[] = [], weightKg: number = 0.5
): MarketAnalysis & { autoPartAnalysis: AutoPartAnalysis; seasonalInfo: SeasonalInfo } {
  const compliance = analyzeCompliance(title, description, categoryPath);
  const logisticsRisks = analyzeLogisticsRisk(title, description, weightKg);
  const demand = analyzeMarketDemand(title, description, categoryPath);
  const autoPart = analyzeAutoParts(title, description);
  const seasonal = getSeasonalInfo();

  const warnings: string[] = [];
  const recommendations: string[] = [];
  const riskTags: string[] = [];

  if (compliance.forbidden.length > 0) {
    warnings.push(`❌ 禁止商品: ${compliance.forbidden.map(c => c.category).join('、')}`);
    compliance.forbidden.forEach(c => {
      recommendations.push(`⚠️ ${c.description}`);
      riskTags.push('禁止');
    });
  }

  if (compliance.highRisk.length > 0) {
    warnings.push(`⚠️ 高风险: ${compliance.highRisk.map(c => c.category).join('、')}`);
    compliance.highRisk.forEach(c => {
      recommendations.push(`📋 ${c.description}`);
      if (c.restrictions) recommendations.push(`   限制: ${c.restrictions.slice(0, 2).join('; ')}`);
      if (c.alternatives) recommendations.push(`   替代: ${c.alternatives.slice(0, 2).join('; ')}`);
      riskTags.push('高风险');
    });
  }

  const isForbidden = compliance.forbidden.length > 0;
  const isRestricted = compliance.highRisk.length > 0 || compliance.mediumRisk.length > 0;

  const isLogisticsRisk = logisticsRisks.some(r => r.riskLevel === 'high' || r.riskLevel === 'medium');
  if (isLogisticsRisk) {
    logisticsRisks.filter(r => r.riskLevel !== 'safe').forEach(r => {
      warnings.push(`📦 物流风险(${r.type}): ${r.description}`);
      recommendations.push(`   建议: ${r.recommendations.slice(0, 2).join('; ')}`);
      riskTags.push(r.type);
    });
  }

  let hasHighDemandInsight = false;
  if (demand.isHighDemand) {
    recommendations.push(`✅ 市场需求: ${demand.matchedCategories.join('、')} - 需求旺盛`);
    hasHighDemandInsight = true;
  }

  if (autoPart.isAutoPart) {
    recommendations.push(`🚗 汽配分析: ${autoPart.autoCategory} - DIY评分${autoPart.diyFriendliness}/100, 市场需求${autoPart.demandPotential}/100`);
    if (autoPart.diyFriendliness >= 70 && autoPart.demandPotential >= 75) {
      recommendations.push(`   ⭐ 高潜力汽配商品，推荐重点关注`);
    }
  }

  if (seasonal.seasonalScore >= 80 && !hasHighDemandInsight) {
    recommendations.push(`🌟 当前${seasonal.currentSeason}季节热销品类: ${seasonal.peakCategories.slice(0, 2).join('、')}`);
  }

  let complianceScore = 100;
  if (isForbidden) complianceScore = 0;
  else {
    complianceScore -= compliance.highRisk.length * 20;
    complianceScore -= compliance.mediumRisk.length * 10;
    complianceScore = Math.max(0, complianceScore);
  }

  let logisticsScore = 100;
  const highRisks = logisticsRisks.filter(r => r.riskLevel === 'high').length;
  const mediumRisks = logisticsRisks.filter(r => r.riskLevel === 'medium').length;
  logisticsScore -= highRisks * 25;
  logisticsScore -= mediumRisks * 10;
  logisticsScore = Math.max(0, logisticsScore);

  let marketScore = demand.demandLevel;
  if (autoPart.isAutoPart) {
    marketScore = Math.round((marketScore * 0.4 + autoPart.score * 0.6));
  }
  marketScore = Math.max(0, Math.min(100, marketScore));

  const overallScore = isForbidden ? 0 : Math.round((complianceScore * 0.3 + logisticsScore * 0.2 + marketScore * 0.5));

  const demandLevels: Record<number, 'none' | 'low' | 'medium' | 'high' | 'very_high'> = {
    0: 'none', 1: 'low', 2: 'medium', 3: 'high', 4: 'very_high', 5: 'very_high'
  };

  return {
    isForbidden,
    isRestricted,
    isLogisticsRisk,
    isHighDemand: demand.isHighDemand,
    demandLevel: demandLevels[Math.floor(demand.demandLevel / 20)] || 'low',
    complianceScore,
    logisticsScore,
    marketScore,
    overallScore,
    warnings,
    recommendations,
    riskTags: Array.from(new Set(riskTags)),
    autoPartAnalysis: autoPart,
    seasonalInfo: seasonal
  };
}

export function getComplianceSummary(analysis: MarketAnalysis & { autoPartAnalysis?: AutoPartAnalysis }): string {
  const parts: string[] = [];
  
  if (analysis.isForbidden) {
    parts.push('🚫 禁止销售 - 建议立即放弃该商品');
  } else if (analysis.isRestricted) {
    parts.push('⚠️ 需要特殊审批 - 建议谨慎考虑');
  } else {
    parts.push('✅ 合规检查通过');
  }

  parts.push(`📋 综合评分: ${analysis.overallScore}/100`);
  parts.push(`   合规: ${analysis.complianceScore}/100`);
  parts.push(`   物流: ${analysis.logisticsScore}/100`);
  parts.push(`   市场: ${analysis.marketScore}/100`);

  if (analysis.autoPartAnalysis?.isAutoPart) {
    parts.push(`🚗 汽配评分: ${analysis.autoPartAnalysis.score}/100 (${analysis.autoPartAnalysis.autoCategory})`);
  }

  if (analysis.riskTags.length > 0) {
    parts.push(`🔖 风险标签: ${analysis.riskTags.join(', ')}`);
  }

  return parts.join('\n');
}

export function getHighDemandCategoriesForCurrentSeason(): CategoryDemandConfig[] {
  const currentMonth = new Date().getMonth() + 1;
  return RUSSIA_HIGH_DEMAND_CATEGORIES
    .map(cat => {
      let boosted = cat.demandScore;
      if (cat.seasonality && cat.seasonality.includes(currentMonth)) {
        boosted = Math.min(100, boosted + 20);
      }
      return { ...cat, boostedDemand: boosted };
    })
    .sort((a, b) => (b as any).boostedDemand - (a as any).boostedDemand);
}

export function getAutoPartCategoriesSorted(): AutoPartCategory[] {
  return [...AUTO_PART_CATEGORIES]
    .map(cat => ({
      ...cat,
      overallScore: Math.round(
        (100 - cat.competitiveness) * 0.35 +
        cat.avgProfit * 0.3 +
        cat.marketSize * 0.25 +
        (100 - cat.diyDifficulty) * 0.1
      )
    }))
    .sort((a, b) => (b as any).overallScore - (a as any).overallScore);
}

export { RUSSIA_HIGH_DEMAND_CATEGORIES, AUTO_PART_CATEGORIES };