export type NavigationGroup = { order: string[]; hidden: string[] };
export type NavigationPreferences = {
  version: number;
  groups: Record<string, NavigationGroup>;
};
export const navigationCatalog: Record<
  string,
  { title: string; items: [string, string][]; locked?: string[] }
> = {
  main: {
    title: "一级导航",
    items: [
      ["home", "首页"],
      ["assets", "资产与投资"],
      ["cashbook", "收支账本"],
      ["planning", "财富规划"],
      ["notebook", "投资手札"],
      ["analytics", "分析复盘"],
    ],
  },
  assets: {
    title: "资产与投资",
    items: [
      ["holdings", "持仓"],
      ["records", "产品与账户"],
    ],
  },
  "assets.records": {
    title: "资产 · 产品与账户",
    items: [
      ["products", "投资产品"],
      ["accounts", "账户档案"],
      ["liabilities", "负债"],
      ["reconcile", "核对"],
    ],
  },
  cashbook: {
    title: "收支账本",
    items: [
      ["events", "全部流水"],
      ["investments", "投资交易"],
      ["dividends", "基金分红"],
      ["imports", "账单中心"],
      ["budgets", "月度预算"],
      ["todos", "待办"],
    ],
  },
  planning: {
    title: "财富规划",
    items: [
      ["goals", "目标与方案"],
      ["cashflow", "现金流与还款"],
    ],
  },
  "planning.goals": {
    title: "规划 · 目标与方案",
    items: [
      ["goals", "财富目标"],
      ["scenarios", "方案比较"],
      ["strategies", "文字策略"],
    ],
  },
  "planning.cashflow": {
    title: "规划 · 现金流与还款",
    items: [
      ["forecast", "现金流预测"],
      ["recurring", "周期收支"],
      ["loans", "贷款与还款计划"],
      ["calendar", "业务日历"],
    ],
  },
  notebook: {
    title: "投资手札",
    items: [
      ["all", "全部手札"],
      ["pre_trade", "交易前计划"],
      ["review", "交易后复盘"],
      ["journal", "心得与假设"],
    ],
  },
  "notebook.details": {
    title: "手札 · 详情",
    items: [
      ["versions", "历史版本"],
      ["attachments", "附件"],
    ],
  },
  analytics: {
    title: "分析复盘",
    items: [
      ["calendar", "收益日历"],
      ["allocation", "持仓配置"],
      ["market", "市场环境与提醒"],
      ["settlement", "行情与结算"],
      ["reports", "收益指标与审计"],
    ],
  },
  "analytics.reports": {
    title: "分析 · 收益指标与审计",
    items: [
      ["performance", "收益与口径"],
      ["audit", "修订与审计"],
    ],
  },
  "analytics.allocation": {
    title: "分析 · 持仓配置",
    items: [
      ["allocation", "当前配置"],
      ["tags", "标签与目标"],
      ["holdings", "持仓明细"],
    ],
  },
  "analytics.market": {
    title: "分析 · 市场环境",
    items: [
      ["watchlist", "市场自选"],
      ["rules", "条件提醒"],
      ["display", "首页显示"],
    ],
  },
  "analytics.settlement": {
    title: "分析 · 行情与结算",
    items: [
      ["quotes", "自动行情"],
      ["prices", "净值与行情"],
      ["derivatives", "衍生品结算"],
    ],
  },
  "investment.trading": {
    title: "投资 · 交易工具",
    items: [
      ["events", "交易记录"],
      ["plans", "定投计划"],
      ["transit", "在途资金"],
    ],
  },
  settings: {
    title: "管理中心",
    items: [
      ["members", "空间与成员"],
      ["templates", "配置参考"],
      ["navigation", "导航偏好"],
      ["help", "名词帮助"],
      ["fx", "汇率记录"],
      ["sources", "账单适配"],
      ["exports", "导出与备份"],
      ["security", "隐私与安全"],
    ],
    locked: ["navigation"],
  },
  admin: {
    title: "管理工作台",
    items: [
      ["users", "用户管理"],
      ["spaces", "空间管理"],
      ["trash", "空间回收站"],
      ["glossary", "名词帮助配置"],
      ["security", "管理员安全"],
      ["templates", "配置参考"],
      ["sources", "数据源配置"],
      ["audit", "管理审计"],
    ],
  },
};
export function orderedNavigation<T extends { key: string }>(
  items: T[],
  preference?: NavigationGroup,
): T[] {
  const order = [...new Set(preference?.order || [])];
  return [...items].sort((a, b) => {
    const rank = (key: string) => {
      const i = order.indexOf(key);
      return i === -1
        ? order.length + items.findIndex((x) => x.key === key)
        : i;
    };
    return rank(a.key) - rank(b.key);
  });
}
export function navigationHidden(
  group: string,
  key: string,
  preference?: NavigationGroup,
) {
  return (
    !navigationCatalog[group]?.locked?.includes(key) &&
    !!preference?.hidden?.includes(key)
  );
}

/** Resolve an explicit route independently from visibility; hiding never revokes access. */
export function selectNavigationKey(
  items: { key: string }[],
  group: string,
  preference: NavigationGroup | undefined,
  options: {
    explicit: boolean;
    directKey?: string | null;
    activeKey?: string;
    defaultActiveKey?: string;
    chosen?: string;
  },
): string | undefined {
  const visible = orderedNavigation(items, preference).filter(
    (i) => !navigationHidden(group, i.key, preference),
  );
  const requested = options.explicit
    ? items.some((i) => i.key === options.directKey)
      ? options.directKey
      : options.activeKey || options.defaultActiveKey
    : options.chosen;
  if (
    requested &&
    items.some((i) => i.key === requested) &&
    (options.explicit || !navigationHidden(group, requested, preference))
  )
    return requested;
  return (
    visible.find(
      (i) =>
        i.key === (options.activeKey || options.defaultActiveKey) &&
        !preference?.order?.length,
    )?.key || visible[0]?.key
  );
}
