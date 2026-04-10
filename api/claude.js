const fetch = require('node-fetch');

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

const SYSTEM_PROMPT = `あなたはプロンプトエンジニアリングと実務設計の専門家です。
ユーザーが入力した短い・弱い依頼を、ChatGPTがより正確で実用的に答えやすい強いプロンプトへ変換してください。

条件:
- まず依頼内容を読み、用途に最適な専門視点を判断する
- perspective が "auto" 以外なら、その視点を優先する
- 強化後プロンプトは必ず『あなたは〜です』から始める
- 目的に応じた観点・評価軸・制約条件を具体的に追加する
- 出力形式と粒度を明確に指定する
- ChatGPTにそのまま貼れる日本語プロンプトとして出力する
- 先頭に【使用視点: ○○】を1行入れる
- その後に【強化後プロンプト】を出す
- さらに【強化ポイント】を箇条書きで出す
- さらに【このまま使う方法】を短く出す
- さらに【追加で深掘りする追撃プロンプト】を1本出す
- 出力は実務でそのまま使える形にする
- 過剰に長くしすぎず、使いやすさを優先する
- 金融助言や投資推奨のような危うい方向に寄せず、比較・整理・リスク洗い出し・判断材料整理の方向で強化する
- 依頼が曖昧でも、ユーザーが次に進みやすい形へ補正する

出力形式（JSON のみ。前置き・説明不要）:
{
  "selectedPerspective": "使用した視点名（例: マーケター）",
  "improvedPrompt": "強化後プロンプト（そのままChatGPTに貼れるもの）",
  "whyImproved": ["強化ポイント1", "強化ポイント2"],
  "usageGuide": "このまま使う方法（短文）",
  "followupPrompt": "追撃プロンプト（1本）",
  "previewBenefits": ["得られやすいもの1", "得られやすいもの2"],
  "suggestedNextAction": "次にやること（短文）"
}`;

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

module.exports = async (req, res) => {
  // CORS（同一オリジン想定だが念のため）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'このエンドポイントはPOSTのみ対応しています。' });
  }

  const { rawPrompt, preset, perspective, goal, depth, outputFormat, strictness } = req.body || {};

  // 入力チェック
  if (!rawPrompt || rawPrompt.trim() === '') {
    return res.status(400).json({ error: '依頼内容を入力してください。' });
  }

  // APIキーチェック
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'APIキーが設定されていません。Vercelの環境変数を確認してください。' });
  }

  try {
    const userPrompt = buildUserPrompt({ rawPrompt, preset, perspective, goal, depth, outputFormat, strictness });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error:', response.status, errBody);
      return res.status(502).json({ error: 'AIとの通信に失敗しました。しばらく待ってから再試行してください。' });
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';

    // JSONを抽出してパース
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('JSON not found in response:', content);
      return res.status(500).json({ error: '結果の解析に失敗しました。もう一度お試しください。' });
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return res.status(200).json({
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
    console.error('Server error:', err);
    return res.status(500).json({ error: 'サーバーエラーが発生しました。もう一度お試しください。' });
  }
};
