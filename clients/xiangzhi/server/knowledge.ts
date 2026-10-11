import type { Knowledge } from '../shared/types.js';

/** Summaries of the sources reviewed in docs/design.md; no promises about relationship outcomes. */
export const KNOWLEDGE: Knowledge[] = [
  {
    id: 'intimacy-process', title: '亲密感来自互动过程', author: 'Laurenceau, Barrett & Pietromonaco', year: 1998, kind: 'research',
    summary: '研究讨论自我披露、对方的披露及感知到的回应，与日常互动中的亲密感之间的关系。',
    application: '分享与当前话题有关的真实感受，也留出空间听对方表达。',
    limitation: '研究关联不是让特定对象产生好感的公式，也不能据此判断某人的内心。',
    url: 'https://doi.org/10.1037/0022-3514.74.5.1238',
  },
  {
    id: 'responsiveness', title: '回应中的理解、重视与关心', author: 'Harry T. Reis', year: 2007, kind: 'principle',
    summary: '伴侣回应的理论强调，一个人是否感到自己的体验被理解、被重视、被关心。',
    application: '先确认自己是否听懂，再回应对方的感受；拿不准时用简短问题澄清。',
    limitation: '这是理解互动的理论视角，不是心理诊断；具体需要仍由对方表达。',
    url: 'https://www.sas.rochester.edu/psy/people/faculty/reis_harry/assets/pdf/Reis_2007.pdf',
  },
  {
    id: 'questions-context', title: '提问需要结合情境', author: 'Avraham N. Kluger & Thomas E. Malloy', year: 2019, kind: 'research',
    summary: '对提问与约会研究的再分析提醒我们，结论会受到分析方式和互动情境影响。',
    application: '问题要自然承接对方说的话；对方疲惫或不想继续时，允许停下来。',
    limitation: '不能把“多问问题”当作普遍有效的吸引策略，也不能只靠问题数量评估交流质量。',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6857721/',
  },
];
