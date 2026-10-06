-- 0145：下线旧版（snapshot.resolution@1）定位策略体系。开发期一次性清理存量数据：
-- 1) platform_config(_revisions)：browserAi.resolutionCeiling / defaultResolution 换算为 locator 并删除旧键（schemaVersion → 8）
-- 2) targets.resolution_policy：删除 preference / ceiling 旧键，清空后置 NULL
-- 3) 场景文档（草稿 / 版本 / 知识提案）：删除顶层 resolution / locatorProtocol，删除步骤 policy.resolution
-- 4) runs.snapshot：删除 @1 协议的 resolution 冻结块（新运行一律冻结 @2 定位计划）

-- 场景编排 nodes 的递归清理：step 节点删 policy.resolution；block 节点递归 then / else / body。
-- portability-exception: 一次性清理旧版定位策略(snapshot.resolution@1)存量数据；旧字段深嵌于 JSON 文档/递归节点，只能用 JSON 运算符与函数表达
CREATE OR REPLACE FUNCTION "__SCHEMA__".strip_legacy_step_policy_nodes(nodes jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT COALESCE(jsonb_agg(
    CASE
      WHEN node->>'kind' = 'step' AND node->'step' ? 'policy' AND node->'step'->'policy' ? 'resolution'
        THEN jsonb_set(node, '{step,policy}', (node->'step'->'policy') - 'resolution'::text)
      WHEN node->>'kind' = 'block' AND node ? 'then'
        THEN CASE
          WHEN node ? 'else'
            THEN jsonb_set(
              jsonb_set(node, '{then}', "__SCHEMA__".strip_legacy_step_policy_nodes(node->'then')),
              '{else}', "__SCHEMA__".strip_legacy_step_policy_nodes(node->'else'))
          ELSE jsonb_set(node, '{then}', "__SCHEMA__".strip_legacy_step_policy_nodes(node->'then'))
        END
      WHEN node->>'kind' = 'block' AND node ? 'body'
        THEN jsonb_set(node, '{body}', "__SCHEMA__".strip_legacy_step_policy_nodes(node->'body'))
      ELSE node
    END
  ), '[]'::jsonb)
  FROM jsonb_array_elements(nodes) AS node;
$$;

-- 平面 steps（V1 文档 / 已编译 definition）的清理。
-- portability-exception: 一次性清理旧版定位策略(snapshot.resolution@1)存量数据；旧字段深嵌于 JSON 文档/递归节点，只能用 JSON 运算符与函数表达
CREATE OR REPLACE FUNCTION "__SCHEMA__".strip_legacy_step_policy_steps(steps jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT COALESCE(jsonb_agg(
    CASE WHEN step->'policy' ? 'resolution'
      THEN jsonb_set(step, '{policy}', (step->'policy') - 'resolution'::text)
      ELSE step END
  ), '[]'::jsonb)
  FROM jsonb_array_elements(steps) AS step;
$$;

-- 顶层清理：删除 resolution / locatorProtocol，并把 steps 或 nodes 里的旧步骤策略剥掉。
-- portability-exception: 一次性清理旧版定位策略(snapshot.resolution@1)存量数据；旧字段深嵌于 JSON 文档/递归节点，只能用 JSON 运算符与函数表达
CREATE OR REPLACE FUNCTION "__SCHEMA__".strip_legacy_scenario_document(doc jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE
    WHEN doc ? 'nodes'
      THEN jsonb_set(
        (doc - 'resolution'::text) - 'locatorProtocol'::text,
        '{nodes}',
        "__SCHEMA__".strip_legacy_step_policy_nodes(doc->'nodes'),
        TRUE)
    WHEN doc ? 'steps'
      THEN jsonb_set(
        (doc - 'resolution'::text) - 'locatorProtocol'::text,
        '{steps}',
        "__SCHEMA__".strip_legacy_step_policy_steps(doc->'steps'),
        TRUE)
    ELSE doc - 'resolution'::text - 'locatorProtocol'::text
  END;
$$;

-- 1) 平台配置：旧字段换算成 locator（仅在 locator 缺失时），删除旧键并推进 schemaVersion。
-- portability-exception: 一次性清理旧版定位策略(snapshot.resolution@1)存量数据；旧字段深嵌于 JSON 文档/递归节点，只能用 JSON 运算符与函数表达
UPDATE "__SCHEMA__".platform_config
SET document = jsonb_set(
      jsonb_set(
        document - 'schemaVersion'::text,
        '{browserAi}',
        (document->'browserAi') - 'resolutionCeiling'::text - 'defaultResolution'::text,
        TRUE
      ),
      '{locator}',
      CASE
        WHEN document ? 'locator' THEN document->'locator'
        ELSE jsonb_build_object(
          'v', 2,
          'defaultPlan', jsonb_build_object('v', 2, 'order',
            CASE document->'browserAi'->>'defaultResolution'
              WHEN 'deterministic_only' THEN '["rule"]'::jsonb
              WHEN 'prefer_deterministic_text' THEN '["rule","text_ai"]'::jsonb
              WHEN 'prefer_text_ai' THEN '["text_ai","rule"]'::jsonb
              WHEN 'prefer_ai' THEN '["text_ai","vision_ai","rule"]'::jsonb
              WHEN 'ai_only' THEN '["text_ai","vision_ai"]'::jsonb
              ELSE '["rule","text_ai","vision_ai"]'::jsonb
            END),
          'limits', jsonb_build_object('v', 2, 'allowed',
            CASE document->'browserAi'->>'resolutionCeiling'
              WHEN 'deterministic_only' THEN '["rule"]'::jsonb
              WHEN 'prefer_deterministic_text' THEN '["rule","text_ai"]'::jsonb
              WHEN 'prefer_text_ai' THEN '["rule","text_ai"]'::jsonb
              ELSE '["rule","text_ai","vision_ai"]'::jsonb
            END)
        )
      END,
      TRUE
    ) || '{"schemaVersion": 8}'::jsonb
WHERE document ? 'browserAi';

-- 历史修订为不可变审计记录（有拒绝改写的触发器），保留 v7 原状；
-- 读取/恢复时由 shared 的 upgradePlatformConfigDocument v7→v8 升级函数换算，见 platform-config.ts。
-- portability-exception: 一次性清理旧版定位策略(snapshot.resolution@1)存量数据；旧字段深嵌于 JSON 文档/递归节点，只能用 JSON 运算符与函数表达
UPDATE "__SCHEMA__".targets
SET resolution_policy = CASE
      WHEN (resolution_policy - 'preference'::text - 'ceiling'::text) = '{}'::jsonb THEN NULL
      ELSE resolution_policy - 'preference'::text - 'ceiling'::text
    END
WHERE resolution_policy ?| ARRAY['preference', 'ceiling'];

-- 3) 场景草稿 / 版本 / 知识提案文档。
-- portability-exception: 一次性清理旧版定位策略(snapshot.resolution@1)存量数据；旧字段深嵌于 JSON 文档/递归节点，只能用 JSON 运算符与函数表达
UPDATE "__SCHEMA__".scenario_drafts
SET document = "__SCHEMA__".strip_legacy_scenario_document(document);

-- 不可变触发器只保护业务事实不被运行链路篡改；本迁移是受控的一次性数据清理，
-- 摘除触发器改写后立即按 0006 的原定义重建。
DROP TRIGGER IF EXISTS scenario_versions_immutable ON "__SCHEMA__".scenario_versions;
DROP TRIGGER IF EXISTS runs_snapshot_immutable ON "__SCHEMA__".runs;

-- portability-exception: 一次性清理旧版定位策略(snapshot.resolution@1)存量数据；旧字段深嵌于 JSON 文档/递归节点，只能用 JSON 运算符与函数表达
UPDATE "__SCHEMA__".scenario_versions
SET definition = "__SCHEMA__".strip_legacy_scenario_document(definition),
    authoring_document = CASE
      WHEN authoring_document IS NULL THEN NULL
      ELSE "__SCHEMA__".strip_legacy_scenario_document(authoring_document)
    END;

-- portability-exception: 一次性清理旧版定位策略(snapshot.resolution@1)存量数据；旧字段深嵌于 JSON 文档/递归节点，只能用 JSON 运算符与函数表达
UPDATE "__SCHEMA__".map_authoring_proposals
SET document = "__SCHEMA__".strip_legacy_scenario_document(document)
WHERE document IS NOT NULL;

-- 4) 运行快照：@1 冻结块整体删除（旧运行按仅规则解释，新运行一律 @2）。
-- portability-exception: 一次性清理旧版定位策略(snapshot.resolution@1)存量数据；旧字段深嵌于 JSON 文档/递归节点，只能用 JSON 运算符与函数表达
UPDATE "__SCHEMA__".runs
SET snapshot = snapshot - 'resolution'::text
WHERE snapshot->'resolution'->>'protocol' = 'snapshot.resolution@1';

-- portability-exception: 不可变触发器在数据清理后按 0006 原定义重建
CREATE TRIGGER scenario_versions_immutable
  BEFORE UPDATE ON "__SCHEMA__".scenario_versions
  FOR EACH ROW
  EXECUTE FUNCTION "__SCHEMA__".reject_scenario_version_mutation();

-- portability-exception: 不可变触发器在数据清理后按 0006 原定义重建
CREATE TRIGGER runs_snapshot_immutable
  BEFORE UPDATE ON "__SCHEMA__".runs
  FOR EACH ROW
  EXECUTE FUNCTION "__SCHEMA__".reject_run_snapshot_mutation();

DROP FUNCTION "__SCHEMA__".strip_legacy_scenario_document(jsonb);
DROP FUNCTION "__SCHEMA__".strip_legacy_step_policy_steps(jsonb);
DROP FUNCTION "__SCHEMA__".strip_legacy_step_policy_nodes(jsonb);
