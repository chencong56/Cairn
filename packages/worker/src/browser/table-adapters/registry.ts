import type { AdapterHelpers, TableAdapter } from './types.js'
import { easyuiAdapter } from './easyui.js'
import { jqgridAdapter } from './jqgrid.js'
import { extjsAdapter } from './extjs.js'
import { layuiAdapter } from './layui.js'
import { elementuiAdapter } from './elementui.js'
import { finereportAdapter } from './finereport.js'
import { aggridAdapter } from './aggrid.js'
import { antdAdapter } from './antd.js'
import { handsontableAdapter } from './handsontable.js'

type AdapterFactory = (h: AdapterHelpers) => TableAdapter

/**
 * 控件适配器注册表（顺序即识别优先级）。新增一种控件：新增 <shape>.ts 并在此登记，
 * 同时在 shared 的识别结果枚举与 TableShape 里加上 shape；一致性用例会逐个校验已登记的适配器。
 */
export const ADAPTER_FACTORIES: AdapterFactory[] = [easyuiAdapter, jqgridAdapter, extjsAdapter, layuiAdapter, elementuiAdapter, finereportAdapter, aggridAdapter, antdAdapter, handsontableAdapter]
