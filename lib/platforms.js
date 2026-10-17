/**
 * dsh-douyin-publish · platforms —— 每个平台一份"档案"：地址、控件选择器、能力边界。
 *
 * 为什么单独一份：抖音和 B站的投稿页结构完全不同（B站甚至不换 URL 就切到编辑页，
 * 标题框会预填文件名，话题是"标签"而不是简介里的 #话题）。把这些差异塞进
 * if/else 会很快烂掉；一份声明式的档案能让"新增第三个平台"只动这一个文件。
 *
 * **verified 的含义**：`true` = 作者在真机（真登录态）上把整条链路跑通并核对过选择器。
 * 没核对过的一律 `false`，调用即明确拒绝 —— 不拿别的平台的选择器去瞎点。
 *
 * @module dsh-douyin-publish/platforms
 */

/** 文件是怎么交给页面的。 */
export const ATTACH_MODES = Object.freeze({
  /** 本机起一个只读的 127.0.0.1 小服务，页面用 fetch 取回来、用 DataTransfer 塞进 input。 */
  inject: 'inject',
  /** 真实点击上传按钮，等系统"打开文件"对话框，用 UI 自动化填路径（老办法，大文件/注入被拦时的退路）。 */
  dialog: 'dialog',
});

export const PLATFORMS = Object.freeze({
  douyin: {
    key: 'douyin',
    label: '抖音',
    verified: true,
    uploadUrl: 'https://creator.douyin.com/creator-micro/content/upload',
    /** 进入编辑页后 URL 会带这个片段（B站不换 URL，所以它是可选的旁证）。 */
    editUrlMark: '/content/post/video',
    attach: {
      inputSelector: 'input[type=file]',
      /** 注入失败或文件太大时的退路：真点这个按钮，等系统对话框。 */
      dialogText: '上传视频',
    },
    selectors: {
      title: 'input[placeholder*="作品标题"]',
      caption: '[contenteditable="true"]',
      coverEntry: '选择封面',
      submitText: '发布',
      draftText: '暂存离开',
    },
    /** 编辑页"就绪"的判据（页面里执行）。 */
    editReady: '!!document.querySelector(\'input[placeholder*="作品标题"]\')',
    /** 可见性：页面上真实存在的中文文案 → 值。 */
    visibility: { public: '公开', friends: '好友可见', private: '仅自己可见' },
    /** 话题怎么落地：inline = 写进简介（"#话题 "）。 */
    topicMode: 'inline',
    supports: { visibility: true, cover: true },
  },

  bilibili: {
    key: 'bilibili',
    label: 'B站',
    verified: true,
    uploadUrl: 'https://member.bilibili.com/platform/upload/video/frame',
    /** B站投稿页上传完成后**不换 URL**，编辑表单是同一个页面上长出来的 —— 所以不能靠 URL 判断。 */
    editUrlMark: null,
    attach: {
      inputSelector: 'input[type=file]',
      dialogText: '上传视频',
    },
    selectors: {
      title: 'input.input-val[placeholder*="稿件标题"]',
      tagInput: 'input.input-val[placeholder*="创建标签"]',
      caption: '.ql-editor[data-placeholder*="填写更全面"]',
      coverEntry: '添加封面',
      submitText: '立即投稿',
      draftText: '存草稿',
      /** "更多设置"折叠面板的展开把手。 */
      moreToggle: 'span.label',
      /** 可见范围的两个选项（在"更多设置"里）。 */
      visibilityOption: 'span.check-radio-v2-name',
    },
    editReady: '!!document.querySelector(\'input.input-val[placeholder*="稿件标题"]\')',
    /** B站：公开可见 / 仅自己可见（在"更多设置 → 可见范围"里）。 */
    visibility: { public: '公开可见', private: '仅自己可见' },
    /** B站没有"好友可见"。 */
    topicMode: 'tags',
    supports: { visibility: true, cover: false },
  },

  xiaohongshu: {
    key: 'xiaohongshu',
    label: '小红书',
    verified: false,
    uploadUrl: 'https://creator.xiaohongshu.com/publish/publish',
    attach: {},
    selectors: {},
    editReady: 'false',
    visibility: {},
    topicMode: 'inline',
    supports: {},
  },

  x: {
    key: 'x',
    label: 'X（推特）',
    verified: false,
    uploadUrl: 'https://x.com/compose/post',
    attach: {},
    selectors: {},
    editReady: 'false',
    visibility: {},
    topicMode: 'inline',
    supports: {},
  },
});

/** 平台键列表。 */
export const PLATFORM_KEYS = Object.keys(PLATFORMS);

/**
 * 取平台档案。
 * @param {string} key 平台键
 * @returns {object} 档案（未知键回落到抖音）
 */
export function platformOf(key) {
  return Object.hasOwn(PLATFORMS, String(key)) ? PLATFORMS[String(key)] : PLATFORMS.douyin;
}
