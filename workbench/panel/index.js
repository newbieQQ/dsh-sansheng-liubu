/**
 * dsh-sansheng-liubu-workbench — 三省六部工作台面板（Web 客户端包）。
 *
 * 宿主侧入口只是占位：profile 组合要求 bundles 列表里的每个包都声明
 * dsh.bundle（补丁层），且补丁行加载的宿主插件就是本文件。面板的实际
 * 功能全在 Web 客户端（lib/client.js，见 package.json 的 dsh.client）。
 * 缺了这层声明时，宿主会在启动时以 "declares no dsh.bundle" 跳过本包，
 * 右侧栏的「朝堂」入口便不会出现。
 */

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-sansheng-liubu-workbench'

/** Plugin body: nothing host-side; the client half does the work. */
export function apply(ctx) {}
