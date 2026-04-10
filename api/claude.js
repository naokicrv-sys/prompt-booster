const fetch = require('node-fetch');

// ===== パスコード検証 =====
function getTier(passcode) {
  const adminCode  = process.env.ADMIN_PASSCODE  || '';
  const memberCode = process.env.MEMBER_PASSCODE || '';
  if (adminCode  && passcode === adminCode)  return 'admin';
  if (memberCode && passcode === memberCode) return 'member';
  return 'free';
}

// ===== グローバル日次制限（インメモリ）=====
// Vercelのインスタンスごとにリセットされるが、低トラフィックでは十分な抑止力になる
const DAILY_GLOBAL_LIMIT = parseInt(process.env.DAILY_GLOBAL_LIMIT || '100', 10);
let globalUsage = { date: '', count: 0 };

function getTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function checkAndIncrementGlobal() {
  const today = getTodayUTC();
  if (globalUsage.date !== today) globalUsage = { date: today, count: 0 };
  if (globalUsage.count >= DAILY_GLOBAL_LIMIT) return false;
  globalUsage.count++;
  return true;
}

// ===== 合言葉誤入力ロック（インメモリ）=====
const MAX_PASSCODE_ATTEMPTS = 5;
const LOCK_DURATION_MS = 60 * 60 * 1000; // 1時間
const passcodeLockMap = new Map(); // ip → { attempts, lockedUntil }

function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'] || '';
  return (fwd ? fwd.split(',')[0] : req.socket?.remoteAddress || 'unknown').trim();
}

function isPasscodeLocked(ip) {
  const entry = passcodeLockMap.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true;
  passcodeLockMap.delete(ip); // ロック期限切れ → 削除
  return false;
}

function recordPasscodeFailure(ip) {
  const entry = passcodeLockMap.get(ip) || { attempts: 0, lockedUntil: null };
  entry.attempts++;
  if (entry.attempts >= MAX_PASSCODE_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCK_DURATION_MS;
    console.warn(`[passcode lock] IP ${ip} locked for 1 hour after ${entry.attempts} failed attempts`);
  }
  passcodeLockMap.set(ip, entry);
}

function clearPasscodeFailures(ip) {
  passcodeLockMap.delete(ip);
}

// 視点の内部ラベルマッピング
const PERSPECTIVE_MAP = {
  design:     'デザイナー（UI/UX・ブランディング・視覚表現）',
  legal:      '弁護士（リーガルチェック・契約・リスク）',
  marketing:  'マーケター（集客・CVR・コピー）',
  engineer:   'エンジニア（設計・コード・アーキテクチャ）',
  management: '経営コンサル（戦略・KPI・事業計画）',
  writing:    'コピーライター（文章・セールス・SNS）',
  finance:    '投資家/CFO（財務・リスク・リターン分析）',
  video:      '映像ディレクター（動画構成・演出・YouTube）',
  auto:       '内容から最適な視点を自動選択',
};

const SYSTEM_PROMPT = `あなたはプロンプトエンジニアリングの専門家です。
入力された短い依頼を、ChatGPTが正確に答えやすい強いプロンプトへ変換してください。

ルール:
- 用途に最適な専門視点を判断する（perspective指定があればそれを優先）
- 強化後プロンプトは『あなたは〜です』から始める
- 観点・制約・出力形式を具体的に追加する
- 金融助言・投資推奨は避け、比較・整理・リスク洗い出しの方向で強化する
- 各フィールドは必ず簡潔にまとめること。improvedPromptは200文字以内、他のフィールドも短く

必ずJSONのみを返すこと（前置き・説明不要）:
{"selectedPerspective":"視点名","improvedPrompt":"強化後プロンプト","whyImproved":["ポイント1","ポイント2"],"usageGuide":"使い方（短文）","followupPrompt":"追撃プロンプト1本","previewBenefits":["得られるもの1","得られるもの2"],"suggestedNextAction":"次にやること"}`;

function buildUserPrompt({ rawPrompt, preset, perspective, goal, depth, outputFormat, strictness }) {
  const perspectiveLabel = PERSPECTIVE_MAP[perspective] || '自動判定';
  const presetText = preset && preset !== 'free' ? `用途プリセット: ${preset}` : '';

  return `以下の依頼を強い ChatGPT プロンプトに変換してください。

【元の依頼】
${rawPrompt}

【設定】
${presetText}
視点: ${perspective === 'auto' ? 'AI自動判定' : perspectiveLabel}
目的: ${goal || '分かりやすくしたい'}
深さ: ${depth || '標準でほしい'}
厳しさ: ${strictness || '実務レベルに整える'}
出力形式: ${outputFormat || '自由'}

JSONフォーマットのみで返してください。`;
}

// 必ずJSONを返すヘルパー（res.json()に依存しない）
function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(body);
}

function jsonError(res, status, error, details = '') {
  console.error('[claude api error]', error, details);
  return sendJSON(res, status, { ok: false, error, details });
}

module.exports = async (req, res) => {
  // OPTIONS プリフライト
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    return jsonError(res, 405, 'このエンドポイントはPOSTのみ対応しています。');
  }

  const { rawPrompt, preset, perspective, goal, depth, outputFormat, strictness, passcode } = req.body || {};
  const ip = getClientIP(req);
  const tier = getTier(passcode || '');

  // パスコード確認専用リクエスト
  if (rawPrompt === '_passcode_check_') {
    if (isPasscodeLocked(ip)) {
      return jsonError(res, 429, '誤入力が続いたため1時間ロックされています。時間をおいて再試行してください。');
    }
    if (tier === 'free' && passcode) {
      // 合言葉が入力されたが不正 → 失敗記録
      recordPasscodeFailure(ip);
      const entry = passcodeLockMap.get(ip);
      const remaining = MAX_PASSCODE_ATTEMPTS - (entry?.attempts || 0);
      return sendJSON(res, 200, {
        ok: true, tier,
        attemptsRemaining: Math.max(0, remaining),
      });
    }
    // 正しい合言葉 → 失敗記録をリセット
    clearPasscodeFailures(ip);
    return sendJSON(res, 200, { ok: true, tier });
  }

  // 入力チェック
  if (!rawPrompt || rawPrompt.trim() === '') {
    return jsonError(res, 400, '依頼内容を入力してください。');
  }

  // グローバル日次制限（メンバー・管理者は対象外）
  if (tier === 'free' && !checkAndIncrementGlobal()) {
    return jsonError(res, 429, '本日のサービス全体の利用上限に達しました。明日またお試しください。');
  }

  // APIキーチェック
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonError(res, 500, 'APIキーが設定されていません。', 'ANTHROPIC_API_KEY が未設定です。Vercel の Environment Variables を確認してください。');
  }

  try {
    const userPrompt = buildUserPrompt({ rawPrompt, preset, perspective, goal, depth, outputFormat, strictness });

    // Promise.race で25秒タイムアウト（AbortController不要）
    const fetchPromise = fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), 25000)
    );

    let response;
    try {
      response = await Promise.race([fetchPromise, timeoutPromise]);
    } catch (raceErr) {
      if (raceErr.message === 'TIMEOUT') {
        return jsonError(res, 504, 'AIの応答に時間がかかりすぎたため中断しました。少し時間をおいて再試行してください。', 'timeout after 25s');
      }
      throw raceErr;
    }

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error:', response.status, errBody);
      const msg =
        response.status === 401 ? 'APIキーが無効です。Vercelの環境変数を確認してください。' :
        response.status === 429 ? 'APIの利用制限に達しました。しばらく待ってから再試行してください。' :
        response.status === 400 ? 'リクエストの形式が不正です。' :
        `AIとの通信に失敗しました（ステータス: ${response.status}）`;
      return jsonError(res, 502, msg, errBody.slice(0, 300));
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';
    console.log('raw content:', content.slice(0, 300));

    // マークダウンコードブロック・前後テキストを除去してJSONを抽出
    let parsed;
    try {
      // ```json ... ``` または ``` ... ``` を除去
      const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      // { } で囲まれた部分を抽出
      const jsonMatch = stripped.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('no JSON found');
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('JSON parse failed. raw content:', content);
      return jsonError(res, 500, '結果の解析に失敗しました。もう一度お試しください。', content.slice(0, 300));
    }

    return sendJSON(res, 200, {
      ok: true,
      tier,
      improvedPrompt:      parsed.improvedPrompt      || '',
      selectedPerspective: parsed.selectedPerspective || '',
      whyImproved:         parsed.whyImproved         || [],
      usageGuide:          parsed.usageGuide          || '',
      followupPrompt:      parsed.followupPrompt      || '',
      previewBenefits:     parsed.previewBenefits     || [],
      beforeText:          rawPrompt,
      suggestedNextAction: parsed.suggestedNextAction || '',
    });

  } catch (err) {
    console.error('Server error:', err.name, err.message);
    const msg = err.message?.includes('fetch')
      ? 'ネットワークエラーが発生しました。'
      : 'サーバーエラーが発生しました。';
    return jsonError(res, 500, msg, err.message);
  }
};
