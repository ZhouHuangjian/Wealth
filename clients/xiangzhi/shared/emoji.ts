import type {EmojiRecognition, Message} from './types.js';

export const EMOJI_PARSER_VERSION = 'wechat-emoji-v2' as const;
const names = [
  '微笑','撇嘴','色','发呆','得意','流泪','害羞','闭嘴','睡','大哭','尴尬','发怒','调皮','呲牙','惊讶','难过','酷','冷汗','抓狂','吐','偷笑','可爱','白眼','傲慢','饥饿','困','惊恐','流汗','憨笑','悠闲','奋斗','咒骂','疑问','嘘','晕','疯了','衰','骷髅','敲打','再见','擦汗','抠鼻','鼓掌','糗大了','坏笑','左哼哼','右哼哼','哈欠','鄙视','委屈','快哭了','阴险','亲亲','吓','可怜','菜刀','西瓜','啤酒','篮球','乒乓','咖啡','饭','猪头','玫瑰','凋谢','嘴唇','爱心','心碎','蛋糕','闪电','炸弹','刀','足球','瓢虫','便便','月亮','太阳','礼物','拥抱','强','弱','握手','胜利','抱拳','勾引','拳头','差劲','爱你','NO','OK','爱情','飞吻','跳跳','发抖','怄火','转圈','磕头','回头','跳绳','投降','激动','乱舞','献吻','左太极','右太极','嘿哈','捂脸','奸笑','机智','皱眉','耶','红包','鸡','蜡烛','吃瓜','加油','汗','天啊','社会社会','旺柴','好的','打脸','哇','翻白眼','666','让我看看','叹气','苦涩','裂开','合十','福','烟花','爆竹','庆祝','笑脸','笑哭','破涕为笑','摊手',
] as const;
const builtinNames = new Set<string>(names);
const unicodeNames: Record<string,string> = {
  '😀':'笑脸','😃':'睁眼笑脸','😄':'眯眼笑脸','😁':'咧嘴笑脸','😆':'大笑','😅':'带汗笑脸','😂':'笑哭','🤣':'笑到打滚',
  '🙂':'微笑脸','🙃':'倒置笑脸','😉':'眨眼','😊':'微笑红脸','😇':'光环笑脸','🥰':'带爱心笑脸','😍':'爱心眼','🤩':'星星眼',
  '😘':'飞吻','😗':'嘟嘴','😙':'眯眼亲吻','😚':'闭眼亲吻','😋':'舔嘴唇','😛':'吐舌','😜':'眨眼吐舌','🤪':'歪眼吐舌','😝':'眯眼吐舌',
  '🤗':'张开双手的笑脸','🤭':'捂嘴','🫢':'睁眼捂嘴','🤫':'嘘','🤔':'思考','🫡':'敬礼','🤐':'拉链嘴','😐':'平嘴脸','😑':'无表情脸','🤦':'捂脸','🤷':'摊手',
  '😶':'无嘴脸','😏':'歪嘴笑脸','😒':'侧眼脸','🙄':'翻白眼','😬':'露齿脸','🤥':'长鼻脸','😌':'闭眼平和脸','😔':'低头脸','😪':'带鼻泡的困脸',
  '🤤':'流口水','😴':'睡觉','😷':'戴口罩','🤒':'含温度计','🤕':'缠绷带','🤢':'绿色脸','🤮':'呕吐','🥵':'热脸','🥶':'冷脸',
  '🥳':'派对笑脸','😎':'墨镜笑脸','🤓':'戴眼镜笑脸','🧐':'单片眼镜脸','😕':'歪嘴脸','😟':'皱眉脸','🙁':'轻微皱嘴脸','☹':'皱嘴脸',
  '😮':'张嘴脸','😯':'抬眉张嘴脸','😲':'睁眼张嘴脸','😳':'睁眼红脸','🥺':'含泪眼','🥹':'带泪笑脸','😦':'皱眉张嘴脸','😧':'紧眉张嘴脸',
  '😨':'蓝额张嘴脸','😰':'带汗蓝额脸','😥':'带泪皱眉脸','😢':'流泪','😭':'大哭','😱':'抱脸张嘴','😖':'紧皱脸','😣':'紧闭眼脸',
  '😞':'低垂嘴角脸','😓':'带汗低头脸','😩':'皱眉张嘴脸','😫':'闭眼张嘴脸','🥱':'打哈欠','😤':'鼻孔冒气','😡':'红色皱眉脸','😠':'皱眉脸','🤬':'符号遮嘴脸',
  '💀':'骷髅','☠':'骷髅交叉骨','💩':'便便','🤡':'小丑','👻':'幽灵','👽':'外星人','🤖':'机器人','😺':'笑脸猫','😸':'眯眼笑猫','😹':'笑哭猫','😻':'爱心眼猫','🙈':'捂眼猴','🙉':'捂耳猴','🙊':'捂嘴猴',
  '👋':'挥手','🤚':'举起手背','🖐':'张开手掌','✋':'举手','🖖':'分指手势','👌':'OK手势','🤌':'捏手指','🤏':'捏一点','✌':'V手势','🤞':'交叉手指','🤟':'爱你手势','🤘':'角形手势','🤙':'电话手势',
  '👍':'竖大拇指','👎':'大拇指向下','✊':'举拳','👊':'出拳','🤛':'左拳','🤜':'右拳','👏':'鼓掌','🙌':'双手举起','🫶':'手比爱心','👐':'张开双手','🤲':'手掌并拢','🤝':'握手','🙏':'合十',
  '💪':'弯曲手臂','🫵':'指向观者','👀':'一双眼睛','❤️':'红心','❤':'红心','🧡':'橙心','💛':'黄心','💚':'绿心','💙':'蓝心','💜':'紫心','🖤':'黑心','🤍':'白心','🤎':'棕心','🩷':'粉心','💔':'心碎','💕':'两颗心','💞':'旋转的心','💓':'跳动的心','💗':'变大的心','💖':'闪亮的心','💘':'箭穿心',
  '🌹':'玫瑰','🥀':'凋谢的花','🌷':'郁金香','🌸':'樱花','🎉':'庆祝彩纸','🎊':'彩球','🎂':'蛋糕','🎁':'礼物','☕':'热饮','🍵':'茶','🍺':'啤酒','🍻':'碰杯','🍉':'西瓜','🔥':'火焰','✨':'闪光','💯':'一百分','✅':'勾号','❌':'叉号','❓':'问号','❗':'感叹号','💤':'睡眠符号',
};
const segmenter = new Intl.Segmenter('zh', {granularity:'grapheme'});
const glyphPattern = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|[0-9#*]\uFE0F?\u20E3/u;
// Conventional possibilities are reference labels, never a conclusion about this sender.
const commonUsage:Record<string,string>={
  '捂脸':'常用于调侃、自嘲、缓和语气或表示不好意思，需结合前后文。',
  '嘿哈':'常用于轻松回应、打趣或活跃气氛，需结合前后文。',
  '微笑':'常用于礼貌回应、缓和语气，也可能带有客套或反讽，需结合前后文。',
  '呲牙':'常用于开玩笑、夸张地笑或轻松回应，需结合前后文。',
  '笑哭':'常用于夸张地回应笑点，也可能带有无奈或自嘲，需结合前后文。',
  '偷笑':'常用于会意、打趣或含蓄地回应笑点，需结合前后文。',
  '抱拳':'常用于感谢、致意、佩服或客气地请求，需结合前后文。',
  '握手':'常用于致意、赞同、表示合作或达成共识，需结合前后文。',
  '合十':'常用于感谢、拜托、祝愿或致意，需结合前后文。',
  '爱心':'常用于支持、感谢、喜爱或友好回应，单独使用不能确认关系，需结合前后文。',
  '调皮':'常用于打趣、逗趣或缓和措辞，需结合前后文。',
  '摊手':'常用于表示不确定、无奈、解释不了或轻松地带过，需结合前后文。',
  '机智':'常用于调侃、表示想到了办法或会意，需结合前后文。',
  '汗':'常用于缓和尴尬、自嘲或回应意外情况，需结合前后文。',
  '尴尬':'常用于自嘲、缓和气氛或回应不太好接的话，需结合前后文。',
};
const usageAliases:Record<string,string>={
  '破涕为笑':'笑哭','笑到打滚':'笑哭','微笑脸':'微笑','微笑红脸':'微笑','咧嘴笑脸':'呲牙','露齿脸':'尴尬',
  '吐舌':'调皮','眨眼吐舌':'调皮','歪眼吐舌':'调皮','眯眼吐舌':'调皮','带汗笑脸':'汗','带汗低头脸':'汗',
  '红心':'爱心','粉心':'爱心','两颗心':'爱心','旋转的心':'爱心','闪亮的心':'爱心','手比爱心':'爱心',
};
function description(name:string,builtin:boolean):string{
  const usage=commonUsage[usageAliases[name]??name];
  return usage?`${name}：${usage}`:builtin?`微信内置“${name}”表情。`:`“${name}”图形。`;
}

/** Recognize bounded glyphs, never arbitrary bracketed instructions or inferred emotion. */
export function parseEmojiText(text: string, recognizedAt = ''): EmojiRecognition | undefined {
  if (!text || text.length > 10_000) return undefined;
  if(!text.includes('[')&&!glyphPattern.test(text))return undefined;
  const found: {index:number; token:EmojiRecognition['tokens'][number]}[] = [];
  for (const match of text.matchAll(/\[([^\[\]\r\n]{1,12})\]/g)) {
    if (builtinNames.has(match[1])) found.push({index:match.index,token:{value:match[0],name:match[1],description:description(match[1],true)}});
    if(found.length>=32)break;
  }
  for (const part of glyphPattern.test(text)?segmenter.segment(text):[]) {
    if (!glyphPattern.test(part.segment)) continue;
    const normalized = part.segment.replace(/[\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]/gu,'');
    const name = unicodeNames[part.segment] ?? unicodeNames[normalized] ?? 'Unicode 表情';
    found.push({index:part.index,token:{value:part.segment.slice(0,80),name,description:description(name,false)}});
    if(found.length>=64)break;
  }
  const tokens=found.sort((a,b)=>a.index-b.index).slice(0,32).map(value=>value.token);
  return tokens.length?{tokens,parserVersion:EMOJI_PARSER_VERSION,recognizedAt}:undefined;
}

/** Re-derive from unchanged raw text so imports and manual edits never display stale labels. */
export function messageEmojiRecognition(message: Pick<Message,'text'|'kind'|'sentAt'>): EmojiRecognition | undefined {
  return (!message.kind||message.kind==='text')?parseEmojiText(message.text,message.sentAt??''):undefined;
}
