// A client-side mirror of server/engine/dictionaries.mjs's DEFAULT_REGION_DICT /
// DEFAULT_FEATURE_DICT, used purely to pre-populate the rename-rules editor with something
// legible on first open instead of a blank slate.
//
// Why a mirror and not a fetch: there is no `GET` endpoint that serves these defaults (the
// backend only ever *consumes* renameOptions — see server/api/subscriptions.mjs's
// `resolveNodes`), and this task's file list is frontend-only. If the backend's dictionaries
// change, this copy can drift; that's an accepted, documented gap (see task-5-report.md) rather
// than an attempt to add a new backend route out of scope.
//
// This only matters for the *initial* values shown in the editor — once the user has the page
// open, every edit is sent verbatim as `renameOptions` on each preview/save call, so the actual
// rename behavior is always driven by what's on screen, never by this file, after first load.
import type { JBoxRenameRegionEntry } from '@/api/jbox'

export const DEFAULT_RENAME_TEMPLATE = '{region}-{feature}-{seq}'
export const DEFAULT_UNKNOWN_LABEL = '其他'
export const DEFAULT_SEQ_PAD = 2

export const DEFAULT_REGION_DICT: JBoxRenameRegionEntry[] = [
  { code: '', name: '亚洲', icon: 'globe:earth-asia', keywords: ['jp', 'japan', '日本', '东京', '東京', '大阪', 'sg', 'singapore', '新加坡', '狮城', '獅城', 'tw', 'taiwan', '台湾', '台灣', '臺灣', '台北', 'kr', 'korea', '韩国', '韓國', '首尔', '首爾'] },
  { code: 'HK', name: '香港', keywords: ['hk', 'hong kong', 'hongkong', '香港', '深港'] },
  { code: 'US', name: '美国', keywords: ['us', 'united states', 'america', '美国', '美國', '洛杉矶', '洛杉磯', '硅谷', '圣何塞', '西雅图', '纽约'] },
  { code: '', name: '欧非', icon: 'globe:earth-europe', keywords: ['波', '柬', '尼', '也', '克', '比', '尔', '立', '冰', '秘', '耳', '利', '埃', '希', '孟', '芬', '愛', '澳', '英', '德', '南', '意', '法', '拿', '墨', '印', '越', '俄', '瑞', '智', '荷', '比', '巴', '沙', '班', '泰', '德', '烏', '以'] },
  { code: 'CN', name: '中国', keywords: ['cn', 'china', '中国', '中國', '回国', '回國', 'back to china'] },
]

// 特征改成扁平关键词表:命中哪个词就把那个词本身(转大写)写进节点名,
// 不再折叠成一个统一标签(见 server/engine/dictionaries.mjs 的同名常量)。
export const DEFAULT_FEATURE_KEYWORDS: string[] = ['iepl', 'iplc', 'ipv6', '专线', '家宽', '2x']

// 过滤关键词:机场订阅里混着的公告/广告条目。默认只放最没歧义的三个词——这是个
// "会让节点消失"的功能,默认值宁可保守(见 server/engine/dictionaries.mjs 同名常量)。
export const DEFAULT_EXCLUDE_KEYWORDS: string[] = ['官网', '工单', '客服']
