export type GlossaryEntry = {
  term: string;
  aliases?: string[];
  category: string;
  explanation: string;
  example?: string;
};

/** Public product vocabulary only: never add user account names or financial records. */
export const glossary: GlossaryEntry[] = [
  {
    term: "买入待确认",
    aliases: ["申购在途", "定投买入待确认", "待确认买入金额"],
    category: "投资与收益",
    explanation:
      "已登记扣款、但尚未登记份额确认的剩余金额，包含手工录入和按计划推算的买入。它与已确认持仓市值分开显示，不额外增加净资产，也不把这笔本金当作收益。部分确认或退款后仅保留剩余金额；只有定投计划、尚未记入扣款的期次不计入。自动推算仍应与机构记录核对。",
  },
  {
    term: "按计划自动补录",
    aliases: ["定投自动补录"],
    category: "投资与收益",
    explanation:
      "开启后，系统从选定的生效日期起，将符合交易日规则的计划视为已执行并登记扣款；净值、预计确认日及费用依据齐备后推算份额。它只更新本系统账簿，不操作银行卡或基金账户。结果保留自动推算来源，实际失败或暂停日期应排除。",
  },
  {
    term: "自动确认份额",
    category: "投资与收益",
    explanation:
      "对已自动登记的基金扣款，按申购对应日的正式净值、费用和份额精度计算份额，并在预计确认日后记入持仓。结果是按计划推算，不代表已取得机构确认单；缺少净值或规则时继续等待，不使用盘中估值替代。",
  },
  {
    term: "自动补录生效日期",
    category: "投资与收益",
    explanation:
      "自动记账从这一天开始检查到期定投。默认从今天开始；选择过去日期可能补记过去的扣款和份额，需核对这些期次确实执行且未重复录入。",
  },
  {
    term: "含自动推算",
    category: "投资与收益",
    explanation:
      "这笔持仓包含根据定投计划、历史净值和所设费用自动计算的份额。金额和份额尚需与基金公司的实际确认记录核对；发现失败扣款或差异时应更正相关记录。",
  },
  {
    term: "按预览补录",
    category: "投资与收益",
    explanation:
      "你确认计划确实执行后，采用预览中的历史净值、费用、计算份额和参考确认日期登记账簿。系统会注明这个来源，不表示已获取机构确认单。失败或暂停日期应排除；费用、净值或日期缺失时需补全，尚未确认的金额保留在途。",
  },
  {
    term: "确认补录",
    category: "投资与收益",
    explanation:
      "把已经实际发生、但尚未登记的定投扣款和份额确认记入账簿。提交后会更新资金、在途和持仓，所以需要核对实际金额、费用、份额与日期；仅有估算结果不能证明交易已经发生。",
  },
  {
    term: "份额取整尾差",
    category: "投资与收益",
    explanation:
      "份额保留有限小数位时，扣款金额与份额乘净值再加手续费可能存在很小差额。它与手续费分开记录；实际录入以机构确认单为准，按预览补录会保留计算来源。系统不会用尾差掩盖较大的金额或份额错误。",
  },
  {
    term: "历史定投估算",
    category: "投资与收益",
    explanation:
      "按指定日期区间、交易日和每期金额模拟过去的定投，再用历史净值估算份额与收益。失败或暂停日期可以排除。预览不会扣账户资金、增加真实持仓，也不能代替机构实际成交和份额确认记录。",
  },
  {
    term: "理论份额",
    aliases: ["估算份额"],
    category: "投资与收益",
    explanation:
      "按申购金额、所选费用假设和该期净值计算的参考份额。机构可能采用不同费用或舍入规则，实际份额以确认单为准；预计尚未确认的期次不能作为可卖出份额。",
  },
  {
    term: "疑似占位持仓",
    category: "投资与收益",
    explanation:
      "数量极小且原成本、市值均为零的存量录入，可能来自过去输入框将零自动调成最小正数。系统不会擅自删除；核实是误录后，可在符合无后续交易等条件时撤销，并保留操作记录。",
  },
  {
    term: "机构显示的持仓收益",
    category: "投资与收益",
    explanation:
      "基金公司或券商页面显示的这笔持仓收益，用于和本系统录入的市值、成本核对。它可能与页面总资产采用不同范围，不能直接代替每日收益，也不能用它倒推出尚未确认的份额或成本。",
  },
  {
    term: "待核对",
    category: "投资与收益",
    explanation:
      "已记录的数据存在范围或金额差异，尚不能确认收益。系统保留你填写的资产、份额和成本，并分别显示机构收益与原计算结果；核对完成前不把差额当成确定收益。",
  },
  {
    term: "更正录入",
    category: "投资与收益",
    explanation:
      "修正已有持仓的录入错误，保留旧记录和更正原因。当前入口适用于尚无后续持仓变动的期初记录，允许更正份额、成本和取得日期；不会重新从银行卡扣款，也不会把修改当作买卖交易。",
  },
  {
    term: "可用份额",
    category: "投资与收益",
    explanation:
      "机构当前允许卖出或赎回的份额。它可能受到冻结、交易在途等影响，不一定等于已确认份额，也不一定等于参与收益计算的份额，不能仅凭可用份额自动拆分持仓。",
  },
  {
    term: "数据口径",
    aliases: ["当前市值依据", "这笔权益是哪种数据"],
    category: "行情与风险",
    explanation:
      "说明金额来自已公布的正式净值或结算、盘中参考估算，还是尚未核实的记录。今天录入旧净值不会变成今天的正式收盘数据，盘中权益也不会自动转成结算权益。",
  },
  {
    term: "查看时间",
    aliases: ["查看这笔市值的时间", "查看这笔权益的时间"],
    category: "行情与风险",
    explanation:
      "你实际查看机构页面或行情的时刻，按当前设备时区填写。它不同于净值所属日和机构交易日；不能用查看时间推断基金是否已发布当日净值。",
  },
  {
    term: "持仓核对日期",
    category: "投资与收益",
    explanation:
      "当前份额、剩余成本和持仓状态所对应的日期。价格可能来自更早的净值日，系统不会把今天确认的份额倒填成过去的持仓。",
  },
  {
    term: "交易日历",
    aliases: ["机构交易日历"],
    category: "行情与风险",
    explanation:
      "对应市场已核实的开市和休市日期。周末、各地节假日和调休并不完全相同；只有日历覆盖且市场明确时，系统才自动判断休市。基金临时暂停申赎仍需看产品公告。",
  },
  {
    term: "从机构已有资金中分配",
    category: "资产与账户",
    explanation:
      "把已经录入机构账户的资金分为现金和具体持仓。按持仓当前市值从留存资金中分配，取得成本另行保存用来计算收益；不会把同一份资产重复相加，也不会发起银行扣款。",
    example:
      "机构总额 1000 元，录入当前市值 300 元的基金后，留存资金为 700 元，基金为 300 元。",
  },
  {
    term: "另行补录已有持仓",
    category: "资产与账户",
    explanation:
      "录入尚未包含在机构已记录金额中的持仓，会增加这部分资产而不扣除账户留存资金。只有确认此前录入金额不包含该持仓时才使用，以免重复计入。",
  },
  {
    term: "留存资金",
    category: "资产与账户",
    explanation:
      "机构账户内还没有分配给具体基金、股票等产品的已记录资金。补录机构已有持仓时按当前市值减少该部分，保留产品成本以计算收益；如余额不足，可选择资金来源并记录划转，不会向银行发起实际扣款。",
  },
  {
    term: "永久删除",
    category: "规划与管理",
    explanation:
      "将已经在回收站中的空间及其业务数据彻底移除，系统内不能恢复。平台管理员需核对空间名称并确认影响范围；管理审计仍记录此次操作。",
  },
  {
    term: "业务类型",
    category: "收支与记录",
    explanation:
      "说明一笔记录实际发生了什么，决定它怎样影响现金、持仓和负债。账户之间转钱、基金买入和日常消费应选各自对应类型。",
    example: "把银行卡的钱转到期货账户，选择账户转账，而不是消费支出。",
  },
  {
    term: "基金申购扣款",
    category: "投资与收益",
    explanation:
      "机构已从资金账户扣走申购款，但可能还未确认最终份额。先把金额记录为申购在途，再根据确认单补录份额和净值。",
  },
  {
    term: "基金份额确认",
    category: "投资与收益",
    explanation:
      "机构已经给出申购最终份额和净值，将相应在途款与实际份额对应起来。扣款记录和份额确认不应当作两次独立投入。",
  },
  {
    term: "基金赎回确认",
    category: "投资与收益",
    explanation:
      "机构已经确认减少的基金份额和赎回金额。资金可能还在途，确认成交不代表当天现金已经回到账户。",
  },
  {
    term: "实际交收",
    aliases: ["实际到账"],
    category: "收支与记录",
    explanation:
      "先前交易对应的资金已经实际进入或离开指定账户。用于结束在途状态，不要把同一笔赎回到账再记为额外收入。",
  },
  {
    term: "份额拆分",
    category: "投资与收益",
    explanation:
      "按产品规则增加或减少份额数量，同时相应调整单位净值等数据。拆分本身不会凭空增加持仓总价值，应按公告确认比例。",
  },
  {
    term: "持仓转移",
    category: "投资与收益",
    explanation:
      "把已有产品持仓从一个账户迁到另一个账户，例如转托管。它不等同于新增买入，需保留对应份额及成本的连续性。",
  },
  {
    term: "实际换汇",
    category: "收支与记录",
    explanation:
      "资金实际从一种货币兑换成另一种货币，同时记录转出、转入金额和相关费用。它与只用于报表计算的估值汇率不同。",
  },
  {
    term: "还款拆分",
    category: "规划与管理",
    explanation:
      "把一笔还款分为本金、利息和其他费用。归还本金减少负债，利息和费用则按相应支出记录，不能全部当作本金。",
  },
  {
    term: "借出款",
    category: "资产与账户",
    explanation:
      "你已经借给他人、对方尚未归还的金额，通常作为应收资产记录。收回本金是资产形式变化，不应全额记为新收入。",
  },
  {
    term: "归档",
    category: "规划与管理",
    explanation:
      "把暂时不再使用的对象从日常操作中收起，保留已有记录。是否仍参与特定历史报表，应查看对象和报表的适用规则。",
  },
  {
    term: "冲正",
    aliases: ["已冲正"],
    category: "收支与记录",
    explanation:
      "通过相反方向的正式记录抵消原记录影响，并保留前后关系。用于纠正已经入账的业务，不是将原始证据悄悄删除。",
  },
  {
    term: "持仓价值",
    aliases: ["市值"],
    category: "投资与收益",
    explanation:
      "在选定日期，持有数量按相应价格和单位换算的价值。衍生品还需要结合结算和合约规则，不能简单把名义合约金额当作资产。",
  },
  {
    term: "盘中估值",
    aliases: ["参考估值"],
    category: "行情与风险",
    explanation:
      "交易期间根据可用信息估算出的参考价格或涨跌，可能与正式收盘价或基金最终净值不同。它用来观察变化，不代表成交保证。",
  },
  {
    term: "价格有效日",
    aliases: ["价格日期", "净值日期", "净值 / 行情对应日期"],
    category: "行情与风险",
    explanation:
      "这条价格实际对应的市场日期，不是系统刚刚获取它的日期。即使刚更新页面，最新可用价格也可能仍属于前一个交易日。",
  },
  {
    term: "数据完整度",
    aliases: ["部分完整", "已知部分"],
    category: "行情与风险",
    explanation:
      "说明当前统计需要的价格、汇率或账目是否齐全。只有部分数据时显示已知部分，不能把缺失金额直接当作零。",
  },
  {
    term: "主标签",
    category: "行情与风险",
    explanation:
      "用于主要配置汇总的分类标签。一个产品可能有多个描述标签，但在需要互斥汇总时应明确主分类，避免重复计算同一持仓。",
  },
  {
    term: "当前权重",
    category: "行情与风险",
    explanation:
      "某类持仓在当前组合已纳入统计的总价值中占的比例。它会随价格和现金进出变化，需与预设的目标权重区分。",
  },
  {
    term: "固定持仓价值",
    category: "行情与风险",
    explanation:
      "保持所选持仓数量不变，用不同日期的价格重算价值，以观察这组持仓随市场如何变化。它不是包含历史买卖的真实账户净值曲线。",
  },
  {
    term: "配置参考",
    category: "规划与管理",
    explanation:
      "管理员整理的可查看设置方案，供你了解分类、展示和其他配置方法。应用时应检查具体内容与自己的账簿是否匹配。",
  },

  {
    term: "净资产",
    category: "资产与账户",
    explanation:
      "你拥有的资产总额减去尚未偿还的负债。系统会按选定时点和估值方式汇总，并换算为账簿本位币。",
    example: "现金 5 万元、投资 8 万元、贷款余额 3 万元，净资产为 10 万元。",
  },
  {
    term: "昨结净资产",
    aliases: ["昨结", "昨日结算"],
    category: "资产与账户",
    explanation:
      "按上一统计日的已确认余额、结算或净值口径计算的净资产。它与盘中估值的时间和数据依据不同，不能直接当成今日实时资产。",
  },
  {
    term: "今日估算",
    aliases: ["今日估值"],
    category: "资产与账户",
    explanation:
      "使用可获取的较新行情估算当前资产价值。行情可能延迟，基金估值也可能与最终公布净值不同。",
    example: "基金今日估涨 1%，只用于观察，不能代替最终确认净值。",
  },
  {
    term: "今日估算收益",
    aliases: ["当日估算收益"],
    category: "投资与收益",
    explanation:
      "根据当日有效价格与上一有效估值日的价格变化，结合已记录买卖和分红计算的投资收益，剔除投入本金。正式价格尚未公布时使用参考估值；缺少当日行情或可比基准的项目不会当作零收益。",
    example:
      "持有的基金从 100 元涨到 102 元，当天另买入 10 元，总资产 112 元，收益为 2 元，而不是 12 元。",
  },
  {
    term: "最近确认日收益",
    category: "投资与收益",
    explanation:
      "最近正式报价日期对应的单日投资收益。旁边标注的是实际收益日期；缺少可比基准时显示待补全。QDII 等基金可能晚于收益日才公布净值，不能一律称为昨日收益。",
  },
  {
    term: "净资产变化",
    category: "资产与账户",
    explanation:
      "两个统计时点的净资产差额，包含投资涨跌、收入、支出和资金进出。不同市场的数据日期可能不同，因此它不能直接当作今日投资收益。",
  },
  {
    term: "总资产",
    aliases: ["资产总额"],
    category: "资产与账户",
    explanation:
      "在当前统计口径下汇总的现金、投资等资产价值，尚未扣除负债。缺少价格或汇率的部分可能无法完整计入。",
  },
  {
    term: "可用资金",
    aliases: ["可用余额"],
    category: "资产与账户",
    explanation:
      "当前口径下可以使用的现金，不等于全部账户资产。冻结金额、保证金或尚在途的资金可能不能立即使用。",
  },
  {
    term: "账户",
    aliases: ["账户档案"],
    category: "资产与账户",
    explanation:
      "记录钱或负债所在的位置，例如银行、现金钱包、基金平台、证券账户或期货账户。它不是登录系统用的用户名。",
    example: "建设银行工资卡和广发期货分别建立两个账户。",
  },
  {
    term: "期初余额",
    category: "资产与账户",
    explanation:
      "从启用日期开始记账时，账户已经拥有的金额。它建立记账起点，不作为当天新获得的收入。",
    example: "今天开始记账，银行卡已有 5000 元，将 5000 元录为期初余额。",
  },
  {
    term: "启用日期",
    category: "资产与账户",
    explanation:
      "账户期初数据从哪一天开始生效。查看早于该日期的报表时，期初余额不会被提前计入。",
  },
  {
    term: "当前账面余额",
    aliases: ["账面余额"],
    category: "资产与账户",
    explanation:
      "由系统已记录的期初金额和后续流水推算出的余额。缺记或重复记账会使它与机构实际余额不同，可以通过账户核对发现差额。",
  },
  {
    term: "净资产计值方式",
    aliases: ["计值口径", "计值方式"],
    category: "资产与账户",
    explanation:
      "决定账户如何计入净资产：可以根据账本和持仓明细计算，也可以使用机构提供的总权益。应选择符合该账户记录方式的一项，避免重复统计。",
  },
  {
    term: "机构权益快照",
    aliases: ["机构权益", "权益快照"],
    category: "资产与账户",
    explanation:
      "记录银行或券商在某个时点给出的账户总权益，而不是每笔交易明细。采用此口径的账户需补齐该时点的权益数据。",
    example: "期货结算单写客户权益 20000 元，可作为该结算日的机构权益。",
  },
  {
    term: "本位币",
    category: "资产与账户",
    explanation:
      "整个账簿汇总金额时使用的统一币种。外币账户仍保留原始币种，汇总时再按相应日期的汇率换算。",
    example: "本位币为 CNY 时，美元持仓会折算成人民币后参与净资产汇总。",
  },
  {
    term: "汇率",
    aliases: ["折算汇率", "估值汇率"],
    category: "资产与账户",
    explanation:
      "一种货币换算为另一种货币的比例，需同时指定原币、目标币和适用日期。系统不会把缺少的汇率自动当成 1。",
    example: "USD → CNY 的汇率填 7.2，表示 1 美元折合 7.2 元人民币。",
  },
  {
    term: "原币",
    aliases: ["原币 base"],
    category: "资产与账户",
    explanation: "汇率换算前的货币，也就是公式左边的 base 币种。",
    example: "把美元换算成人民币时，原币是 USD。",
  },
  {
    term: "目标币",
    aliases: ["目标币 quote"],
    category: "资产与账户",
    explanation: "汇率换算后的货币，也就是公式右边的 quote 币种。",
    example: "把美元换算成人民币时，目标币是 CNY。",
  },
  {
    term: "负债",
    category: "资产与账户",
    explanation:
      "尚未偿还的借款或欠款，会从总资产中扣除。新增借款带来现金，也同时增加负债，不等于获得投资收益。",
  },
  {
    term: "负债本金",
    aliases: ["剩余本金", "贷款本金"],
    category: "资产与账户",
    explanation:
      "借入后尚未归还的原始借款金额，不包含未来尚未发生的利息。还款时应区分归还本金和支付利息。",
  },
  {
    term: "冻结金额",
    aliases: ["机构已冻结金额"],
    category: "资产与账户",
    explanation:
      "机构暂时限制使用的资金，例如未成交委托占用的资金。冻结不等于资金已经花掉，应以机构账单的口径为准。",
  },
  {
    term: "账户核对",
    aliases: ["核对口径", "核对时点"],
    category: "资产与账户",
    explanation:
      "选择同一日期和同一种金额口径，把系统记录与银行、券商等机构记录比较。发现差额后查找缺记或重复，而不是直接将差额当成收入。",
  },
  {
    term: "收入",
    category: "收支与记录",
    explanation:
      "从账簿外部获得的收入，如工资。自己两个账户之间转钱应记为转账，避免虚增收入。",
  },
  {
    term: "支出",
    category: "收支与记录",
    explanation:
      "用于消费、费用等的资金流出。买入投资或归还贷款本金会改变资产结构，通常应使用对应业务类型记录。",
  },
  {
    term: "内部转账",
    aliases: ["账户转账", "转入账户", "转出账户"],
    category: "收支与记录",
    explanation:
      "自己在同一账簿内的账户之间移动资金。记录转出和转入两端，资金去向变化不会凭空增加收入或净资产。",
    example: "银行卡向期货账户转入 1 万元：选银行卡转出、期货账户转入。",
  },
  {
    term: "银期转账",
    aliases: ["银期入金", "银期出金", "银期转入", "银期转出"],
    category: "收支与记录",
    explanation:
      "银行账户和期货账户之间的资金转移。银行转入期货叫入金，期货转回银行叫出金；都不是期货交易盈利或亏损。",
  },
  {
    term: "凭证",
    category: "收支与记录",
    explanation:
      "用于核对一笔记录的依据，例如账单编号、成交确认单或备注。可以后续补充，手工记一笔时不必为了提交而编造凭证。",
  },
  {
    term: "冲销",
    category: "收支与记录",
    explanation:
      "保留原记录，同时生成相反方向的记录来撤回影响。已经形成正式账目的记录通常通过冲销更正，以保留可追溯的修改历史。",
  },
  {
    term: "修订",
    aliases: ["数据修订"],
    category: "收支与记录",
    explanation:
      "对已有记录进行有版本的更正。历史统计可能随更正重新计算，修订记录用来说明谁在何时做了什么修改。",
  },
  {
    term: "业务日期",
    aliases: ["经济日期"],
    category: "收支与记录",
    explanation:
      "这笔业务实际发生或应计入账目的日期，可能早于你把它录入系统的日期。补录历史业务时应填写当时的业务日期。",
  },
  {
    term: "期初持仓",
    aliases: ["存量持仓"],
    category: "投资与收益",
    explanation:
      "开始使用系统前已经买入、现在仍然持有的投资。补录时需要确定持有份额、成本和起点，不能只填写产品名称。",
  },
  {
    term: "持仓",
    aliases: ["持仓明细"],
    category: "投资与收益",
    explanation:
      "目前尚未卖出或平仓的投资数量，以及对应的账户、成本和价值。同一产品放在不同账户中会有各自的持仓。",
  },
  {
    term: "投资产品",
    category: "投资与收益",
    explanation:
      "可以买卖或观察的基金、股票、期货、期权等标的。建立产品档案只说明它是什么，不代表已经投入资金；买入或期初持仓才形成持有记录。",
  },
  {
    term: "基金",
    category: "投资与收益",
    explanation:
      "由基金管理人按产品规则管理的一组投资。不同基金的投资市场、确认时间、净值公布时间和分红安排可能不同。",
  },
  {
    term: "基金净值",
    aliases: ["单位净值", "确认净值", "净值"],
    category: "投资与收益",
    explanation:
      "一份基金在相应净值日期的价值。使用份额乘以单位净值估算持有市值；需区分正式公布净值与盘中估值。",
    example: "1000 份、单位净值 1.20 元，持有市值为 1200 元。",
  },
  {
    term: "累计净值",
    category: "投资与收益",
    explanation:
      "按基金披露口径反映历史分红等因素的参考指标。不能直接用持有份额乘累计净值作为当前可赎回市值。",
  },
  {
    term: "份额",
    aliases: ["确认份额"],
    category: "投资与收益",
    explanation:
      "持有基金的数量单位。投入金额需要按最终确认净值和费用折算成份额，金额与份额并不一定相同。",
  },
  {
    term: "现金分红",
    category: "投资与收益",
    explanation:
      "基金分配收益后，将红利以现金方式付给持有人。除息后基金净值通常相应调整，现金到账也需要记录，不能只把净值下降当成亏损。",
  },
  {
    term: "红利再投资",
    aliases: ["红利再投", "分红再投资"],
    category: "投资与收益",
    explanation:
      "将分红金额按基金规定的净值转换成新增基金份额，而不作为现金到账。新增份额以机构最终确认结果为准。",
  },
  {
    term: "权益登记日",
    aliases: ["红利登记日"],
    category: "投资与收益",
    explanation:
      "基金用来确定本次分红权益归属的日期。是否能参与分红应结合持有份额和基金公告规则判断。",
  },
  {
    term: "除息日",
    category: "投资与收益",
    explanation:
      "基金或股票因分红对价格或净值进行相应调整的日期。除息日不一定等于红利实际到账日。",
  },
  {
    term: "分红到账日",
    aliases: ["红利发放日"],
    category: "投资与收益",
    explanation:
      "红利预计或实际发放的日期；渠道处理时间可能不同。预计日期不能替代你账户中的实际到账确认。",
  },
  {
    term: "每份分红",
    category: "投资与收益",
    explanation:
      "每一份基金分配的红利金额。公告有时写成每 10 份或每 100 份分红，录入前需要统一单位。",
    example: "每 10 份分红 0.5 元，相当于每份分红 0.05 元。",
  },
  {
    term: "分红",
    category: "投资与收益",
    explanation:
      "投资产品按公告向持有人分配收益，常见方式为现金分红或红利再投资。分红会影响价格或净值，不能视为在原市值之外凭空多出同额收益。",
  },
  {
    term: "定投",
    aliases: ["定投计划"],
    category: "投资与收益",
    explanation:
      "按设定的周期和金额持续投入某个产品。这里的计划用于提醒和记录安排，不代表系统已替你从银行扣款或完成基金申购。",
  },
  {
    term: "申购",
    category: "投资与收益",
    explanation:
      "向基金申请买入份额。提交金额后，还要等待机构按规则确认份额和成交净值。",
  },
  {
    term: "赎回",
    category: "投资与收益",
    explanation:
      "向基金申请卖出已持有份额。确认成交和资金实际到账可能不在同一天，应分别核对。",
  },
  {
    term: "确认日",
    aliases: ["预计确认日", "份额确认日"],
    category: "投资与收益",
    explanation:
      "机构正式确认申购或赎回结果的日期。页面自动给出的日期是按可用规则计算的预计值，实际以机构记录为准。",
  },
  {
    term: "T+1",
    category: "投资与收益",
    explanation:
      "T 代表有效交易日，+1 代表按该产品适用日历往后一个交易日，不是简单加一个自然日。基金申购确认与证券卖出规则中的 T+1 含义需结合具体业务。",
    example: "周五是有效交易日且周一正常交易时，T+1 为周一。",
  },
  {
    term: "T+2",
    category: "投资与收益",
    explanation:
      "从有效交易日 T 起，再往后数两个适用交易日。境外节假日、基金暂停申购等可能使实际确认晚于预计日期。",
  },
  {
    term: "QDII",
    category: "投资与收益",
    explanation:
      "境内机构发行、主要投资境外市场的一类产品。境内外交易日和时差会影响净值公布与交易确认，不能仅按境内周末推断到账日。",
  },
  {
    term: "FOF",
    category: "投资与收益",
    explanation:
      "主要投资其他基金的基金。因为还需要汇集所投基金的数据，净值披露或交易确认规则可能与普通基金不同。",
  },
  {
    term: "ETF",
    category: "投资与收益",
    explanation:
      "可在交易所交易的基金。通过证券账户买卖时按证券成交记录处理，不应直接套用场外基金申购确认的规则。",
  },
  {
    term: "在途资金",
    category: "投资与收益",
    explanation:
      "已经发起业务但尚未完成确认或到账的资金。例如基金申购已扣款、份额还未确认，或赎回已确认、现金尚未到账。",
  },
  {
    term: "成本",
    aliases: ["持仓成本", "剩余成本"],
    category: "投资与收益",
    explanation:
      "当前持仓对应的投入成本，受系统采用的成本分配规则和已确认费用影响。已卖出部分的成本应与剩余持仓区分。",
  },
  {
    term: "浮动盈亏",
    aliases: ["未实现盈亏", "未实现收益"],
    category: "投资与收益",
    explanation:
      "尚未卖出或平仓部分，按当前价格估算的盈利或亏损。价格变化后数值会改变，不能等同于已经到账的现金收益。",
  },
  {
    term: "已实现盈亏",
    aliases: ["已实现收益"],
    category: "投资与收益",
    explanation:
      "已卖出、平仓或完成结算部分按记录计算出的收益或损失，需结合成本和相关费用确定。",
  },
  {
    term: "净损益",
    aliases: ["净收益"],
    category: "投资与收益",
    explanation:
      "扣除当前统计口径中相关费用后计算出的收益或损失。报表覆盖范围和缺失数据会影响结果是否完整。",
  },
  {
    term: "收益率",
    category: "投资与收益",
    explanation:
      "收益相对于投入或期初价值的比例。不同计算方法对追加投入、取出资金和时间的处理不同，比较时应采用同一种口径。",
  },
  {
    term: "XIRR",
    aliases: ["资金加权收益率"],
    category: "投资与收益",
    explanation:
      "结合每笔投入、取出金额及其实际日期计算的年化收益率。它反映资金投入时机的影响；现金流不足或不存在合适解时可能无法计算。",
  },
  {
    term: "TWR",
    aliases: ["时间加权收益率"],
    category: "投资与收益",
    explanation:
      "把外部资金进出前后的投资区间分开计算，再连接各区间收益，用于减小追加投入和取出时机对业绩比较的影响。",
  },
  {
    term: "年化收益率",
    category: "投资与收益",
    explanation:
      "把某段时间的收益折算为一年的比较口径，不代表未来一年必然获得相同收益。短时间结果年化后可能波动很大。",
  },
  {
    term: "现金流",
    category: "规划与管理",
    explanation:
      "一段时间内流入和流出的现金及其日期。现金流预测用于查看未来是否有足够现金应付支出，不能直接当作已经发生的流水。",
  },
  {
    term: "周期收支",
    category: "规划与管理",
    explanation:
      "按照固定周期重复安排的收入或支出，如每月房租或工资。计划发生时间和实际入账时间需要分别确认。",
  },
  {
    term: "等额本息",
    category: "规划与管理",
    explanation:
      "在利率等条件不变时，每期还款总额通常相同，前期利息较多、本金较少的一种还款方式。具体金额以贷款机构计划为准。",
  },
  {
    term: "等额本金",
    category: "规划与管理",
    explanation:
      "每期偿还相同本金，利息随剩余本金减少而下降的一种还款方式，因此每期总还款通常逐步减少。",
  },
  {
    term: "应急金",
    category: "规划与管理",
    explanation:
      "为临时失业、医疗或其他紧急情况预留的可用资金。规划时应区分可随时使用的现金与短期难以变现的投资。",
  },
  {
    term: "预算",
    aliases: ["月度预算"],
    category: "规划与管理",
    explanation:
      "为某段时间或类别设定的计划支出额度，用来与实际支出比较。设置预算本身不会产生扣款。",
  },
  {
    term: "目标占比",
    aliases: ["目标权重", "持仓占比"],
    category: "行情与风险",
    explanation:
      "希望某类持仓占组合总价值的比例。它用于比较当前配置与计划的差距，不能代替真实买卖记录。",
    example: "计划黄金占 10%，当前占 7%，两者差 3 个百分点。",
  },
  {
    term: "配置偏离",
    aliases: ["偏离目标"],
    category: "行情与风险",
    explanation:
      "当前持仓比例与预设目标比例的差值，常以百分点表示。价格变化和资金投入都可能造成偏离。",
  },
  {
    term: "标签",
    category: "行情与风险",
    explanation:
      "按自己的分类方式组织产品，如黄金、红利低波、标普 500。一个产品可有多个标签，汇总多个标签时需留意交叉持仓。",
  },
  {
    term: "回撤",
    category: "行情与风险",
    explanation:
      "从所选历史区间内的高点下降到当前点的比例。需要明确比较区间和数据类型，基金净值回撤与账户资产回撤不一定相同。",
    example: "从 100 跌到 90，回撤为 10%；从 90 回到 100，需要上涨约 11.11%。",
  },
  {
    term: "条件提醒",
    category: "行情与风险",
    explanation:
      "当你设置的行情条件被满足时产生提醒，例如回撤达到 10%。提醒不会自动交易，缺少或过期数据也不应被当作已满足条件。",
  },
  {
    term: "VIX",
    category: "行情与风险",
    explanation:
      "反映市场对标普 500 未来约 30 天波动预期的指数。数值高低描述预期波动程度，不直接等于股票会涨或会跌。",
  },
  {
    term: "指数",
    category: "行情与风险",
    explanation:
      "按特定规则汇总一组证券表现的指标，例如沪深 300 或标普 500。指数点位不是基金净值，也不一定可以直接买入。",
  },
  {
    term: "红利低波",
    aliases: ["低波红利"],
    category: "行情与风险",
    explanation:
      "一种结合股息与较低历史波动等规则筛选成份的投资风格或指数类别。不同产品采用的指数和筛选方法可能不同，低波不代表没有亏损。",
  },
  {
    term: "标普500",
    aliases: ["标普 500", "S&P 500"],
    category: "行情与风险",
    explanation:
      "衡量美国大型上市公司股票表现的常用指数。持有跟踪基金时，还会受基金费用、跟踪偏差及汇率等因素影响。",
  },
  {
    term: "纳指100",
    aliases: ["纳指 100", "纳斯达克100", "纳斯达克 100"],
    category: "行情与风险",
    explanation:
      "按指数规则选取纳斯达克上市大型非金融公司的指数。它与覆盖范围更广的纳斯达克综合指数不同。",
  },
  {
    term: "行情",
    aliases: ["实时价格", "实时行情"],
    category: "行情与风险",
    explanation:
      "数据源提供的价格、涨跌和时间等公开市场数据。页面显示时间与行情实际时间可能不同，要结合来源、时间戳和延迟状态判断。",
  },
  {
    term: "交易日",
    category: "行情与风险",
    explanation:
      "相关市场或交易所实际开放交易的日期，不等同于所有周一至周五。不同国家节假日和产品暂停交易会造成差异。",
  },
  {
    term: "交易所",
    category: "行情与风险",
    explanation:
      "产品挂牌交易的市场机构，例如上交所、大商所。期货或期权代码的规则与交易所相关，同名或相似代码不能随意混用。",
  },
  {
    term: "期货",
    category: "投资与收益",
    explanation:
      "约定按合约规则交易某种标的的标准化合约。通常采用保证金和逐日结算，合约名义金额不等于你已经投入或拥有的资产金额。",
  },
  {
    term: "期权",
    category: "投资与收益",
    explanation:
      "买方支付权利金获得在规则内买入或卖出标的的权利，卖方承担相应义务。录入时需明确标的、到期月份、看涨或看跌、行权价及合约单位。",
  },
  {
    term: "看涨",
    aliases: ["认购期权"],
    category: "投资与收益",
    explanation:
      "赋予买方按约定行权价买入标的的权利，期权代码中常用 C 表示。买卖方向仍需另外填写，卖出看涨不等于买入看涨。",
  },
  {
    term: "看跌",
    aliases: ["认沽期权"],
    category: "投资与收益",
    explanation:
      "赋予买方按约定行权价卖出标的的权利，期权代码中常用 P 表示。买卖方向仍需另外填写。",
    example: "豆粕 2701 沽 3300 通常对应 m2701-P-3300，实际挂牌以交易所为准。",
  },
  {
    term: "行权价",
    aliases: ["执行价格"],
    category: "投资与收益",
    explanation:
      "期权合约约定的买入或卖出标的价格，不是购买期权时支付的权利金。",
  },
  {
    term: "权利金",
    category: "投资与收益",
    explanation:
      "期权买方向卖方支付的期权价格。若行情按每单位报价，实际支付金额还需乘以合约乘数和合约数量。",
  },
  {
    term: "合约乘数",
    aliases: ["合约单位"],
    category: "投资与收益",
    explanation:
      "一手合约对应的标的数量或每个报价单位对应的金额，用来把报价变动换算成实际盈亏。不同品种不能套用同一个乘数。",
  },
  {
    term: "保证金",
    category: "投资与收益",
    explanation:
      "为履行期货或期权等交易义务而占用的资金。保证金不是合约总价值，也不是买入产品的费用；保证金变化会影响可用资金。",
  },
  {
    term: "开仓",
    category: "投资与收益",
    explanation:
      "新建立期货或期权持仓。需要同时记录买入或卖出方向、数量、价格、合约和所属账户。",
  },
  {
    term: "开仓均价",
    aliases: ["开仓价"],
    category: "投资与收益",
    explanation:
      "这笔期权持仓建立时的平均成交报价，按合约的报价单位填写，不是行权价或全部持仓金额。开仓权利金金额按开仓均价乘以手数和合约乘数计算；手续费另行核对。",
    example: "开仓均价 100、2 手、乘数 10，对应开仓权利金金额 2000。",
  },
  {
    term: "当前持仓市值",
    aliases: ["当前持仓总市值"],
    category: "投资与收益",
    explanation:
      "这笔期权当前全部手数对应的权利金价值，不是每单位行情价格、行权价、保证金或账户总权益。买入和卖出持仓均填写非负的金额，由买卖方向区分持有权利与承担义务；归零时可以填 0。",
    example: "当前报价 120、2 手、乘数 10，持仓总市值为 2400。",
  },
  {
    term: "毛浮动盈亏",
    aliases: ["参考毛浮盈"],
    category: "投资与收益",
    explanation:
      "以当前市值和开仓权利金比较的未平仓参考盈亏。买入持仓为当前市值减开仓金额，卖出持仓方向相反。未扣手续费等成本，不等于已实现收益、今日收益或账户结算盈亏，也不会再次加到账户权益中。",
  },
  {
    term: "买卖方向",
    category: "投资与收益",
    explanation:
      "说明你是买入期权、持有权利，还是卖出期权、承担义务。它与看涨或看跌是两件事：看跌期权既可以买入，也可以卖出。方向决定浮动盈亏的计算方式。",
  },
  {
    term: "期权参考持仓",
    category: "投资与收益",
    explanation:
      "用于查看期权手数、开仓价、市值及参考盈亏的账户内明细。新增或编辑它不会生成成交、扣款或结算记录；资产总额仍按包含期权的机构权益核算，防止重复计算。",
  },
  {
    term: "平仓",
    category: "投资与收益",
    explanation:
      "通过反向交易减少或结束已有的期货或期权持仓。应对应原持仓核算收益，而不是误记成新的相反方向开仓。",
  },
  {
    term: "结算价",
    category: "投资与收益",
    explanation:
      "交易所按规则确定、用于当日结算等业务的价格，可能与最后一笔成交的收盘价不同。",
  },
  {
    term: "逐日结算",
    aliases: ["盯市盈亏"],
    category: "投资与收益",
    explanation:
      "期货等按每日结算口径计算当日盈亏并反映在账户权益中。已计入结算的盈亏不能再当作未计入的持仓收益重复累加。",
  },
  {
    term: "到期日",
    category: "投资与收益",
    explanation:
      "合约按交易所规则到期的日期。最后交易日、行权日和交割日可能不同，需要核对具体品种规则。",
  },
  {
    term: "数据源",
    category: "规划与管理",
    explanation:
      "系统获取公开产品信息、行情等数据的提供方。管理员可设置启用与优先顺序；某来源失败时只会尝试支持同类数据的其他来源。",
  },
  {
    term: "缓存",
    aliases: ["缓存目录"],
    category: "规划与管理",
    explanation:
      "服务器已经保存的公开产品或行情信息，便于快速查找。缓存可能不是最新数据，查看时需留意来源和更新时间。",
  },
  {
    term: "账簿空间",
    aliases: ["空间", "账簿"],
    category: "规划与管理",
    explanation:
      "一组独立保存账户、流水、持仓与成员权限的账簿。同一空间成员可按角色共享数据；个人与家庭可分别建立空间。",
  },
  {
    term: "邀请码",
    category: "规划与管理",
    explanation:
      "允许他人按指定角色加入某个空间的代码。对方可在注册时填写，已有账号也可以使用它加入；有效期、撤销及使用状态会限制其可用性。",
  },
  {
    term: "Owner",
    aliases: ["空间所有者"],
    category: "规划与管理",
    explanation:
      "当前空间的管理角色，可管理成员、配置空间并执行完整导出等操作。它不自动拥有整个平台其他用户和空间的管理权限。",
  },
  {
    term: "Editor",
    aliases: ["编辑成员"],
    category: "规划与管理",
    explanation:
      "可以在所加入空间内录入、维护账目和计划的成员角色，不能代替空间所有者管理全部成员权限。",
  },
  {
    term: "Viewer",
    aliases: ["查看成员"],
    category: "规划与管理",
    explanation: "可以按空间授权查看数据的成员角色，不能新增或修改账目。",
  },
  {
    term: "平台管理员",
    category: "规划与管理",
    explanation:
      "管理整个平台账号、空间和公共数据源的角色。协助他人空间时保留管理员自身身份，相关操作会写入管理记录。",
  },
  {
    term: "管理审计",
    aliases: ["审计", "审计记录"],
    category: "规划与管理",
    explanation:
      "记录谁在什么时间进行了哪项管理或账目变更，用于追踪问题和检查操作。不是对投资正确性或收益的认证。",
  },
  {
    term: "配置模板",
    category: "规划与管理",
    explanation:
      "用于参考或复用设置的配置方案。应用前应查看内容与适用范围，不应把他人的账户余额、流水或登录信息作为模板共享。",
  },
  {
    term: "导航偏好",
    category: "规划与管理",
    explanation:
      "只调整你自己的菜单顺序和显示范围。隐藏菜单不会删除其中的数据或撤销权限，可在管理中心恢复默认。",
  },
];

export type GlossaryOverride = {
  term: string;
  hidden?: boolean;
  category?: string;
  explanation?: string;
  aliases?: string[];
  example?: string;
};
export type GlossaryConfiguration = {
  version: number;
  overrides: GlossaryOverride[];
};
/** Visibility is independent of edited wording; only an explicit reset removes it. */
export function setGlossaryVisibility(
  overrides: GlossaryOverride[],
  term: string,
  hidden: boolean,
) {
  const key = term.toLocaleLowerCase();
  const previous = overrides.find(
    (entry) => entry.term.toLocaleLowerCase() === key,
  );
  const remaining = overrides.filter(
    (entry) => entry.term.toLocaleLowerCase() !== key,
  );
  if (!hidden && !previous?.explanation) return remaining;
  return [...remaining, { ...previous, term, hidden }];
}
export function mergeGlossary(
  overrides: GlossaryOverride[],
  includeHidden = false,
) {
  const entries = new Map(
    glossary.map((entry) => [
      entry.term.toLocaleLowerCase(),
      { ...entry, hidden: false, builtin: true, customized: false },
    ]),
  );
  for (const override of overrides) {
    const key = override.term.toLocaleLowerCase();
    const original = entries.get(key);
    if (!original && (!override.explanation || !override.category)) continue;
    entries.set(key, {
      ...(original || {
        term: override.term,
        explanation: "",
        category: "",
        hidden: false,
        builtin: false,
        customized: false,
      }),
      ...override,
      aliases:
        override.aliases === undefined ? original?.aliases : override.aliases,
      hidden: !!override.hidden,
      customized: true,
    });
  }
  return [...entries.values()].filter(
    (entry) => includeHidden || !entry.hidden,
  );
}
/** Validate the merged vocabulary, including aliases inherited from built-in terms. */
export function glossaryConflict(entries: GlossaryEntry[]) {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    for (const label of [entry.term, ...(entry.aliases || [])]) {
      const key = label.trim().toLocaleLowerCase();
      if (!key) return "名词与别名不能为空";
      const previous = labels.get(key);
      if (previous)
        return `“${label}”同时用于“${previous}”与“${entry.term}”，请使用不同的名词或别名`;
      labels.set(key, entry.term);
    }
  }
  return "";
}
const indexes = new WeakMap<GlossaryEntry[], ReturnType<typeof createIndex>>();
function createIndex(entries: GlossaryEntry[]) {
  const aliases = entries.flatMap((entry) =>
    [entry.term, ...(entry.aliases || [])].map((label) => ({ label, entry })),
  );
  return {
    lookup: new Map(
      aliases.map(({ label, entry }) => [label.toLocaleLowerCase(), entry]),
    ),
    terms: [...aliases].sort((a, b) => b.label.length - a.label.length),
  };
}
function glossaryIndex(entries: GlossaryEntry[]) {
  if (!indexes.has(entries)) indexes.set(entries, createIndex(entries));
  return indexes.get(entries)!;
}
export function findGlossaryEntry(term: string, entries = glossary) {
  return glossaryIndex(entries).lookup.get(term.trim().toLocaleLowerCase());
}
export type GlossaryPart = { text: string; entry?: GlossaryEntry };
/** Prefer the longest matching term and preserve every original character. */
export function glossaryParts(
  text: string,
  entries = glossary,
): GlossaryPart[] {
  const result: GlossaryPart[] = [];
  let cursor = 0;
  let plainStart = 0;
  const normalized = text.toLocaleLowerCase();
  const { terms } = glossaryIndex(entries);
  while (cursor < text.length) {
    const match = terms.find(({ label }) => {
      if (!normalized.startsWith(label.toLocaleLowerCase(), cursor))
        return false;
      if (/^[A-Za-z]/.test(label) && /[A-Za-z0-9]/.test(text[cursor - 1] || ""))
        return false;
      if (
        /[A-Za-z0-9]$/.test(label) &&
        /[A-Za-z0-9]/.test(text[cursor + label.length] || "")
      )
        return false;
      return true;
    });
    if (!match) {
      cursor++;
      continue;
    }
    if (plainStart < cursor)
      result.push({ text: text.slice(plainStart, cursor) });
    result.push({
      text: text.slice(cursor, cursor + match.label.length),
      entry: match.entry,
    });
    cursor += match.label.length;
    plainStart = cursor;
  }
  if (plainStart < text.length) result.push({ text: text.slice(plainStart) });
  return result.length ? result : [{ text }];
}
export function searchGlossary(
  query: string,
  category = "全部",
  entries = glossary,
) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(
    (entry) =>
      (category === "全部" || category === entry.category) &&
      words.every((word) =>
        [
          entry.term,
          ...(entry.aliases || []),
          entry.explanation,
          entry.example || "",
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(word),
      ),
  );
}
