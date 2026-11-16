'use strict';
/**
 * 生成驾驶舱演示数据（可重复运行：npm run seed）
 * 输出：public/data/customers.json
 * 使用固定随机种子，保证每次生成的数据一致、便于对照。
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'data', 'customers.json');
const TOTAL = 168;

let seed = 20261111;
function rnd() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pad = (n) => String(n).padStart(2, '0');
function weighted(list) {
  const total = list.reduce((s, x) => s + x.w, 0);
  let n = rnd() * total;
  for (const x of list) {
    n -= x.w;
    if (n <= 0) return x;
  }
  return list[list.length - 1];
}

const REGIONS = [
  { r: '广东', c: ['深圳', '广州', '东莞'], w: 10 },
  { r: '北京', c: ['北京'], w: 8 },
  { r: '上海', c: ['上海'], w: 8 },
  { r: '江苏', c: ['南京', '苏州', '无锡'], w: 7 },
  { r: '浙江', c: ['杭州', '宁波'], w: 7 },
  { r: '山东', c: ['青岛', '济南'], w: 4 },
  { r: '四川', c: ['成都'], w: 4 },
  { r: '湖北', c: ['武汉'], w: 3 },
  { r: '福建', c: ['厦门', '福州'], w: 3 },
  { r: '河南', c: ['郑州'], w: 3 },
  { r: '陕西', c: ['西安'], w: 2 },
  { r: '辽宁', c: ['沈阳', '大连'], w: 2 },
  { r: '湖南', c: ['长沙'], w: 2 },
  { r: '河北', c: ['石家庄'], w: 2 },
  { r: '安徽', c: ['合肥'], w: 2 },
  { r: '重庆', c: ['重庆'], w: 2 },
  { r: '江西', c: ['南昌'], w: 1 },
  { r: '天津', c: ['天津'], w: 2 },
  { r: '云南', c: ['昆明'], w: 1 },
  { r: '广西', c: ['南宁'], w: 1 }
];

const CHANNELS = [
  { v: '搜索引擎', w: 15 },
  { v: '微信', w: 12 },
  { v: '抖音', w: 10 },
  { v: '官网', w: 9 },
  { v: '朋友推荐', w: 8 },
  { v: '线下活动', w: 6 },
  { v: '小红书', w: 5 },
  { v: '电话', w: 4 },
  { v: 'B站', w: 3 },
  { v: '其他', w: 2 }
];

const CHANNEL_DETAIL = {
  '搜索引擎': ['百度-SEM-品牌词', '百度-SEM-通用词', '百度-SEO-产品页', '360搜索-竞价', '搜狗-自然结果', '必应-SEO-方案页'],
  '微信': ['公众号-推文引流', '朋友圈广告-表单', '视频号-直播留资', '企业微信-客服', '微信群-转介绍'],
  '抖音': ['信息流广告-表单', '短视频-评论区', '直播间-私信', '达人合作-测评'],
  '官网': ['官网-在线咨询', '官网-资料下载', '官网-预约演示', '官网-400电话'],
  '朋友推荐': ['老客户转介绍', '同行推荐', '内部员工推荐', '合作伙伴引荐'],
  '线下活动': ['行业峰会-展台', '城市沙龙-签到', '渠道伙伴-推荐会', '客户开放日'],
  '小红书': ['笔记-搜索进入', '品牌号-私信', '达人种草-合集'],
  '电话': ['400来电', '外呼回访', '展会名录'],
  'B站': ['UP主合作-视频', '科技区-搜索', '评论区-私信'],
  '其他': ['邮件订阅', '第三方平台', '线下门店']
};

const INTENTS = [
  { v: '产品询价', w: 16 },
  { v: '方案对比', w: 11 },
  { v: '预约演示', w: 11 },
  { v: '技术资料', w: 8 },
  { v: '价格政策', w: 8 },
  { v: '竞品了解', w: 6 },
  { v: '合作加盟', w: 5 },
  { v: '售后咨询', w: 4 },
  { v: '其他', w: 3 }
];

const INQUIRY = {
  '产品询价': ['咨询企业版报价及实施周期，约 30 个坐席', '想了解标准版与旗舰版的功能差异和价格', '询问年度采购的折扣与付款方式', '需要一份含部署与培训的整体报价单'],
  '方案对比': ['对比三家厂商后在看数据看板的定制能力', '希望了解与现有 CRM 的集成方案', '询问私有化部署与 SaaS 的差异', '关注多部门权限与数据隔离方案'],
  '预约演示': ['希望本周安排一次线上产品演示', '想看客户数据统计模块的实操演示', '约了下周二带技术团队一起听方案', '要求提供测试账号先试用两周'],
  '技术资料': ['索取 API 文档与数据字典', '咨询支持的数据源与同步频率', '想了解二次开发接口和权限模型', '需要安全合规与等保相关材料'],
  '价格政策': ['询问续费价格与阶梯折扣', '关心超出套餐后的计费规则', '咨询渠道伙伴的价格政策', '想了解教育/非营利优惠'],
  '竞品了解': ['目前在用的是竞品，想评估迁移成本', '询问与竞品在报表能力上的差异', '关注历史数据能否平滑导入'],
  '合作加盟': ['咨询区域代理与渠道合作政策', '想了解集成商合作模式', '询问联合解决方案的落地案例'],
  '售后咨询': ['现有客户反馈报表导出异常', '咨询账号权限调整流程', '询问服务响应时间与升级路径'],
  '其他': ['官网留言，希望销售回电', '未明确诉求，待回访确认', '咨询招聘及商务合作事宜']
};

const STATUSES = [
  { v: '新线索', w: 9 },
  { v: '跟进中', w: 14 },
  { v: '已报价', w: 10 },
  { v: '已成交', w: 8 },
  { v: '已流失', w: 5 }
];

const FEEDBACK = {
  '新线索': ['尚未回访，已分配跟单人员', '电话未接通，改天再试', '已加微信，等待客户回复需求清单', '初次沟通，客户表示先内部了解一下'],
  '跟进中': ['已发送产品资料，约定下周二次沟通', '客户要求补充行业案例', '需求基本明确，正在协调技术评估', '已建群对接，等待对方确认时间', '客户希望先看 demo 再谈价格'],
  '已报价': ['报价单已发出，等待内部审批', '客户认为预算偏高，需要方案精简', '已进入采购流程，等待法务审合同', '对报价无异议，正在走付款审批'],
  '已成交': ['合同已签署，进入实施排期', '首付款到账，已安排启动会', '已完成交付，客户满意度良好', '已续约并追加两个部门席位'],
  '已流失': ['预算冻结，本年度暂缓采购', '最终选择了竞品', '项目取消，暂无后续计划', '多次联系无响应，标记为沉默线索']
};

const OWNERS = ['张敏', '李强', '王芳', '陈杰', '赵磊', '刘洋', '周婷', '吴昊'];
const SURNAME = ['陈', '林', '王', '张', '李', '刘', '周', '吴', '徐', '孙', '赵', '黄', '郑', '何', '郭', '罗', '梁', '宋', '谢', '唐'];
const GIVEN = ['慧敏', '志远', '嘉怡', '文博', '思琪', '俊杰', '晓琳', '宇轩', '雅婷', '浩然', '若曦', '梓涵', '明哲', '欣妍', '子墨', '一诺', '书瑶', '奕辰', '静怡', '泽宇'];
const CO_A = ['云启', '智联', '恒创', '华辰', '拓维', '星河', '锐思', '博远', '安泰', '万象', '鼎新', '蓝海', '联科', '启明', '数擎', '同方'];
const CO_B = ['科技', '信息技术', '数字', '智能', '数据', '网络', '软件', '实业', '医疗', '教育', '制造', '供应链'];
const CO_C = ['有限公司', '集团有限公司', '股份有限公司', '有限公司'];

const today = new Date();
today.setHours(0, 0, 0, 0);

const list = [];
for (let i = 0; i < TOTAL; i++) {
  const region = weighted(REGIONS);
  const city = pick(region.c);
  const channel = weighted(CHANNELS).v;
  const intent = weighted(INTENTS).v;
  const status = weighted(STATUSES).v;

  const d = new Date(today);
  d.setDate(d.getDate() - Math.floor(Math.pow(rnd(), 1.15) * 100));
  d.setHours(int(8, 20), int(0, 59), 0, 0);
  const sourceTime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  let amount = int(8, 90) * 1000;
  if (status === '已成交') amount = int(60, 260) * 1000;
  if (status === '已流失') amount = int(3, 40) * 1000;

  list.push({
    sourceTime,
    region: region.r,
    unit: `${city}市${pick(CO_A)}${pick(CO_B)}${pick(CO_C)}`.replace('北京市市', '北京市').replace('上海市市', '上海市').replace('重庆市市', '重庆市').replace('天津市市', '天津市'),
    name: pick(SURNAME) + pick(GIVEN),
    inquiry: pick(INQUIRY[intent]),
    owner: pick(OWNERS),
    feedback: pick(FEEDBACK[status]),
    channel,
    channelDetail: pick(CHANNEL_DETAIL[channel]),
    intent,
    status,
    amount
  });
}

list.sort((a, b) => a.sourceTime.localeCompare(b.sourceTime));
const items = list.map((r, i) => ({
  id: `C${String(i + 1).padStart(4, '0')}`,
  ...r,
  createdAt: r.sourceTime,
  updatedAt: r.sourceTime
}));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(items, null, 2), 'utf8');
console.log(`[seed] 已生成 ${items.length} 条客户数据 -> ${OUT}`);
console.log(`[seed] 时间范围：${items[0].sourceTime} ~ ${items[items.length - 1].sourceTime}`);
