-- 0146：修复 0145 在平台配置缺 locator 时多写的顶层 "v"。
-- locator 契约是 strictObject({ defaultPlan, limits })，顶层不允许 v（v 只属于 defaultPlan / limits 内部）；
-- 0145 已被执行过的库不能改原文件（校验和），故用本增量幂等地删除多余键。无多余键的库为空操作。
-- portability-exception: 一次性修复存量 JSON 文档的多余键；嵌套键删除只能用 JSON 路径运算符表达
UPDATE "__SCHEMA__".platform_config
SET document = document #- '{locator,v}'
WHERE document->'locator' ? 'v';
