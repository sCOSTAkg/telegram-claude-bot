'use strict';

// ============================================================
// MediaPromptEngine — AI-powered professional prompt generation
// for image, video, animation, and multi-frame scenarios
// ============================================================

const PHOTO_PROMPT_SYSTEM = `You are an expert AI photography and visual art prompt engineer. Your task: transform ANY user request (in any language) into a professional, highly detailed English prompt optimized for AI image generation.

## OUTPUT FORMAT — strict JSON, no markdown fences, no explanations:
{
  "prompt": "detailed English prompt for the image generation API",
  "style": "photorealistic|cinematic|editorial|artistic|abstract|product|fashion|architectural|food|portrait|landscape|illustration|3d_render|anime|minimalist",
  "lighting": "natural|studio|golden_hour|blue_hour|rim|dramatic|soft|neon|volumetric|backlit|overcast|flash|candlelight",
  "composition": "rule_of_thirds|centered|leading_lines|close_up|extreme_close_up|wide|panoramic|overhead|flat_lay|symmetrical|diagonal|frame_within_frame",
  "camera": "eye_level|low_angle|high_angle|birds_eye|dutch_angle|worms_eye|over_shoulder|pov",
  "colorPalette": "warm|cool|neutral|vibrant|muted|monochrome|pastel|earth_tones|high_contrast|complementary",
  "mood": "energetic|calm|dramatic|mysterious|romantic|nostalgic|futuristic|luxurious|playful|dark|ethereal|professional",
  "aspectRatio": "1:1|16:9|9:16|4:3|3:4",
  "modelRecommendation": "nano-banana|nano-banana-2|nano-banana-pro|imagen-3|imagen-3-fast|imagen-4-fast|imagen-4|imagen-4-ultra",
  "negativePrompt": "things to avoid",
  "metadata": {
    "sphere": "detected business sphere or general",
    "theme": "detected theme",
    "locale": "detected location/culture if any"
  }
}

## MODEL SELECTION RULES:
- Fast creative/artistic/illustration/stylized → "nano-banana-2" (fastest, ~500ms)
- Creative with good quality → "nano-banana"
- 4K quality or multi-reference needed → "nano-banana-pro"
- Photorealistic photos, product shots → "imagen-4-fast"
- Maximum photorealistic detail → "imagen-4"
- Ultra premium quality → "imagen-4-ultra"
- Legacy photorealistic → "imagen-3" or "imagen-3-fast"

## ASPECT RATIO RULES:
- Social media post, product → "1:1"
- Landscape, cinematic, presentation, banner → "16:9"
- Story, reel, portrait, mobile → "9:16"
- Standard photo → "4:3" or "3:4"

## DOMAIN-SPECIFIC PROMPT PATTERNS:
- Real estate: wide-angle lens, HDR lighting, twilight exterior, interior staging, clean lines, architectural photography
- Food: overhead angle or 45-degree, shallow DOF, warm tones, steam/freshness details, rustic or clean surface
- Fashion: editorial lighting, model pose description, fabric texture, designer aesthetic, runway or editorial style
- Beauty/cosmetics: macro detail, flawless skin texture, product placement, soft diffused lighting
- Automotive: dynamic angle, reflections, motion blur hint, showroom or scenic backdrop, metallic paint detail
- Tech/product: clean white or gradient background, hero shot, floating elements, screen glow, minimal
- Travel: golden hour, landmark context, human scale, atmospheric haze, vibrant local colors
- Architecture: leading lines, symmetry, material textures, sky replacement quality, urban or nature context
- Portrait: catch lights, skin detail, background bokeh, emotion expression, natural or studio setting
- Luxury/jewelry: macro, sparkle, velvet/silk surface, dramatic rim lighting, high contrast

## PROMPT QUALITY RULES:
- ALWAYS translate to English regardless of input language
- Include specific visual details: textures, materials, colors, spatial relationships
- Add quality markers: "8K resolution, sharp focus, professional photography, highly detailed"
- Describe the scene from camera perspective, not abstractly
- For people: describe pose, expression, clothing, setting — not names/identities
- Maximum 150 words for the prompt
- negativePrompt always includes: "blurry, low quality, watermark, text overlay, distorted, deformed, ugly, duplicate"`;

const VIDEO_PROMPT_SYSTEM = `You are an expert AI video prompt engineer specializing in cinematic motion description. Transform ANY user request (any language) into a professional English video prompt.

## OUTPUT FORMAT — strict JSON, no markdown fences:
{
  "prompt": "detailed English video prompt with motion, camera, lighting description",
  "modelRecommendation": "veo-3.1-fast|veo-3.1|veo-2",
  "duration": 8,
  "aspectRatio": "16:9|9:16|1:1",
  "resolution": "720p|1080p",
  "negativePrompt": "things to avoid",
  "metadata": {
    "sphere": "detected business sphere",
    "theme": "detected theme",
    "locale": "detected location/culture if any",
    "complexity": "simple|medium|complex"
  }
}

## MODEL SELECTION RULES:
- Default / fast generation → "veo-3.1-fast"
- High quality, complex scenes, cinematic → "veo-3.1"
- When A-to-B frames (start+end frame) are provided → "veo-2" (only model supporting this)
- Simple loops, quick previews → "veo-3.1-fast" with duration 4

## DURATION RULES:
- Simple loop (fire, water, breathing) → 4
- Short scene (single action, product rotation) → 6
- Full scene (narrative, complex motion) → 8

## RESOLUTION:
- Default → "720p"
- Cinematic/premium/presentation → "1080p"

## VIDEO PROMPT STRUCTURE (follow this order in the prompt):
1. SUBJECT: What is in the scene, detailed visual description
2. ACTION: What movement happens (subject action, speed, direction)
3. CAMERA: Camera motion (pan left, tilt up, dolly in, crane shot, orbit, static, handheld shake, tracking shot, slow zoom)
4. LIGHTING: Light quality, direction, transitions, time of day
5. ATMOSPHERE: Particles, fog, rain, dust, volumetric rays, lens flare
6. STYLE: Cinematic, documentary, commercial, artistic, slow-motion, timelapse

## DOMAIN-SPECIFIC:
- Product: 360-degree orbit, clean background, hero lighting, slow rotation
- Real estate: smooth drone flight, room-to-room transition, golden hour exterior
- Food: steam rising, sauce pouring in slow-motion, ingredient falling, close-up texture
- Fashion: runway walk, fabric flow in wind, editorial pose transition
- Nature: timelapse clouds, flowing water, wildlife in motion
- Tech: screen animation, UI interaction, device rotation with reflections
- Automotive: tracking shot alongside car, dramatic reveal, headlight beam in dark

## QUALITY RULES:
- ALWAYS write in English
- Describe temporal progression: "starts with... transitions to... ends with..."
- Include specific motion verbs: glides, sweeps, drifts, rushes, floats
- Camera motion is critical — always specify
- Maximum 120 words
- negativePrompt: "blurry, shaky, low quality, watermark, glitch, distorted, static noise"`;

const ANIMATION_PROMPT_SYSTEM = `You are an expert at transforming still images into natural motion descriptions for AI video generation. Given an image description and user instruction, create a professional animation prompt.

## OUTPUT: Return ONLY the animation prompt text (not JSON). Maximum 100 words. English only.

## MOTION CATEGORIES (pick 2-3 that fit the image):

### Organic Motion:
- People: subtle breathing, hair movement, fabric sway, eye blinks, gentle expression shift
- Animals: breathing, ear twitch, tail movement, subtle head turn
- Plants: leaves rustling, flowers swaying, branches bending

### Environmental Motion:
- Water: ripples, reflections shimmering, waves, flowing stream
- Sky: clouds drifting, sun rays shifting, birds flying in distance
- Weather: rain drops, snow falling, wind effects, fog drifting
- Light: sun flicker through leaves, candle flame, neon glow pulse

### Camera Motion (subtle):
- Gentle push-in (dolly forward 5-10%)
- Slow parallax shift (3D depth effect)
- Subtle orbit (5-10 degrees)
- Gentle tilt up/down

### Atmospheric:
- Floating dust particles in light beam
- Heat haze shimmer
- Bokeh light shifts
- Lens flare movement

## RULES:
- SUBTLE motion is ALWAYS better than exaggerated
- Focus on what would naturally move in the scene
- Camera motion should be barely perceptible
- Preserve the composition — don't suggest drastic changes
- If user gives specific instruction, prioritize their intent
- Default: gentle push-in + 2-3 natural motions matching the scene`;

const SCENARIO_PROMPT_SYSTEM = `You are a professional storyboard artist and video director. Create multi-frame video storyboards from user descriptions.

## OUTPUT FORMAT — strict JSON, no markdown fences:
{
  "title": "short title of the video story",
  "totalFrames": 5,
  "totalDuration": 40,
  "characters": {
    "character_id": "EXACT detailed visual description that MUST be repeated VERBATIM in every frame prompt. Include: gender, age range, ethnicity/skin tone, hair (color, length, style), eyes, face features, body type, clothing (specific items, colors, materials), accessories. Example: A young woman in her mid-20s with long straight black hair, warm olive skin, brown almond-shaped eyes, wearing a burgundy silk blouse with pearl buttons, high-waisted dark navy jeans, and white canvas sneakers, carrying a small brown leather crossbody bag"
  },
  "setting": "overall visual setting description reused across frames",
  "frames": [
    {
      "id": 1,
      "title": "short frame title",
      "prompt": "FULL self-contained English video prompt including COMPLETE character descriptions (copied verbatim from characters section), setting, action, camera motion, lighting. Each prompt must work independently.",
      "duration": 8,
      "camera": "camera motion description",
      "transition": "cut|dissolve|match_cut|whip_pan|fade_to_black|none",
      "narrativeNote": "what happens in the story at this point"
    }
  ]
}

## CRITICAL RULES FOR CHARACTER CONSISTENCY:
1. In the "characters" section, write an EXHAUSTIVELY detailed visual description for each character
2. In EVERY frame prompt, copy the COMPLETE character description VERBATIM — do not abbreviate or paraphrase
3. Include clothing, accessories, and distinguishing features in every single frame
4. If a character changes outfit between frames, describe the new outfit completely
5. Use the same descriptive words across all frames — consistency comes from repetition

## FRAME STRUCTURE:
- Minimum 3 frames, maximum 7
- Each frame = 6-8 seconds of video
- First frame: establishing shot, introduce character/setting
- Middle frames: action/development
- Last frame: resolution/climax
- Transitions should create visual continuity

## NARRATIVE STRUCTURE:
- Frame 1: Setup — establish the world and characters
- Frames 2-N-1: Development — build the action, show progression
- Frame N: Resolution — conclude the story, emotional payoff

## CAMERA PROGRESSION (vary across frames):
- Frame 1: Wide establishing shot or medium shot
- Middle: Mix of close-ups, tracking shots, over-shoulder
- End: Pull-back wide shot or dramatic close-up

## RULES:
- ALL text in English
- Each frame prompt must be FULLY SELF-CONTAINED (include all visual details)
- Vary camera angles and motion across frames
- Maintain consistent lighting/time of day unless story requires change
- Keep each frame prompt under 120 words
- Total story should feel cohesive and progressive`;

// Heuristic: detect if prompt is already professional (skip engine)
const PROFESSIONAL_TERMS_RE = /\b(cinematic|8k|4k|bokeh|depth of field|DOF|rim light|volumetric|anamorphic|golden hour|blue hour|rule of thirds|wide[- ]angle|telephoto|macro|studio lighting|key light|fill light|backlit|overexpos|underexpos|f\/\d|ISO \d|shutter speed|aspect ratio|negative space|leading lines)\b/i;

function isAlreadyProfessional(text) {
  if (!text) return false;
  const isEnglish = /^[\x00-\x7F\s.,!?'"():;\-\n]+$/.test(text.slice(0, 100));
  const hasTechnical = PROFESSIONAL_TERMS_RE.test(text);
  return isEnglish && hasTechnical && text.length > 120;
}

// Heuristic context detection
function detectContext(text) {
  const t = (text || '').toLowerCase();
  let language = 'en';
  if (/[а-яё]/i.test(text)) language = 'ru';
  else if (/[\u4e00-\u9fff]/.test(text)) language = 'zh';
  else if (/[\u0600-\u06ff]/.test(text)) language = 'ar';
  else if (/[\u3040-\u30ff]/.test(text)) language = 'ja';
  else if (/[\uac00-\ud7af]/.test(text)) language = 'ko';

  const sphereMap = {
    real_estate: /недвижимост|квартир|дом|интерьер|экстерьер|архитектур|real.?estate|apartment|interior|exterior|building|house|property|жилой|комплекс|фасад/,
    food: /еда|блюдо|рецепт|ресторан|кухня|food|dish|restaurant|recipe|cuisine|pizza|burger|sushi|кофе|coffee|cake|десерт/,
    fashion: /мода|одежд|стиль|показ|runway|fashion|outfit|dress|couture|коллекци|бренд|brand|наряд/,
    beauty: /красот|косметик|макияж|beauty|cosmetic|makeup|skincare|уход|крем|парфюм|perfume/,
    automotive: /авто|машин|car|vehicle|automotive|двигател|колёс|BMW|Mercedes|Tesla|спортивн|гонк/,
    tech: /технолог|гаджет|устройств|приложени|tech|device|gadget|app|software|interface|UI|screen|робот|AI|нейро/,
    travel: /путешестви|travel|tourism|город|city|пляж|beach|гор[аы]|mountain|храм|temple|достопримечат|landmark|отпуск/,
    nature: /природ|nature|лес|forest|океан|ocean|море|sea|закат|sunset|рассвет|sunrise|цвет[оы]к|flower|животн|animal|wildlife/,
    portrait: /портрет|portrait|лицо|face|человек|person|модель|model|фото.*человек|селфи|selfie/,
    product: /продукт|товар|product|упаковк|packaging|бутылк|bottle|флакон|коробк|box|витрин|showcase/,
    luxury: /люкс|luxury|ювелир|jewelry|часы|watch|бриллиант|diamond|золот|gold|серебр|silver|премиум|premium/,
    architecture: /архитектур|architecture|здани|building|небоскрёб|skyscraper|мост|bridge|собор|cathedral|дизайн.*интерьер/,
  };

  let sphere = 'general';
  for (const [key, re] of Object.entries(sphereMap)) {
    if (re.test(t)) { sphere = key; break; }
  }

  const themeMap = {
    cinematic: /кинематограф|cinematic|кино|фильм|movie|film|сцена|scene/,
    commercial: /реклам|commercial|маркетинг|marketing|баннер|banner|промо|promo/,
    editorial: /журнал|magazine|editorial|обложк|cover|публикац/,
    social_media: /пост|инстаграм|instagram|reels|stories|тикток|tiktok|соцсет|social/,
    presentation: /презентац|presentation|слайд|slide|pitch|доклад/,
    artistic: /арт|art|творческ|creative|абстракт|abstract|сюрреал|surreal|фантаз|fantasy/,
  };

  let theme = 'general';
  for (const [key, re] of Object.entries(themeMap)) {
    if (re.test(t)) { theme = key; break; }
  }

  // Locale detection from place names
  let locale = '';
  const localePatterns = [
    [/бишкек|кыргызстан|kyrgyzstan|bishkek/, 'Kyrgyzstan, Central Asia'],
    [/москв|россия|russia|moscow|петербург|petersburg/, 'Russia'],
    [/дубай|dubai|ОАЭ|UAE|абу[- ]даби|abu.dhabi/, 'UAE, Middle East'],
    [/нью[- ]йорк|new.york|манхэттен|manhattan/, 'New York, USA'],
    [/paris|париж|france|франци/, 'Paris, France'],
    [/tokyo|токио|japan|япони/, 'Tokyo, Japan'],
    [/london|лондон|england|англи/, 'London, UK'],
    [/istanbul|стамбул|turkey|турци/, 'Istanbul, Turkey'],
    [/алматы|казахстан|almaty|kazakhstan/, 'Kazakhstan, Central Asia'],
    [/ташкент|узбекистан|tashkent|uzbekistan/, 'Uzbekistan, Central Asia'],
  ];
  for (const [re, loc] of localePatterns) {
    if (re.test(t)) { locale = loc; break; }
  }

  return { language, sphere, theme, locale };
}

function selectImageModel(analysis) {
  const style = (analysis.style || '').toLowerCase();
  const sphere = (analysis.sphere || '').toLowerCase();

  if (['photorealistic', 'product', 'food', 'editorial'].includes(style) ||
      ['food', 'beauty', 'product', 'automotive', 'real_estate', 'luxury', 'jewelry'].includes(sphere)) {
    return 'imagen-4-fast';
  }
  if (['artistic', 'abstract', 'illustration', 'anime', '3d_render', 'minimalist'].includes(style)) {
    return 'nano-banana-2';
  }
  if (style === 'cinematic' || sphere === 'architecture') {
    return 'imagen-4';
  }
  return 'nano-banana';
}

function selectVideoModel(analysis, hasEndFrame) {
  if (hasEndFrame) return 'veo-2';
  const complexity = (analysis.complexity || '').toLowerCase();
  if (complexity === 'complex' || (analysis.resolution === '1080p')) return 'veo-3.1';
  return 'veo-3.1-fast';
}

function parseJSON(text) {
  if (!text) return null;
  // Try direct parse
  try { return JSON.parse(text); } catch (e) { /* continue */ }
  // Try extracting from markdown fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch (e) { /* continue */ }
  }
  // Try extracting first { ... } block (non-greedy to avoid capturing trailing text)
  const braceMatch = text.match(/\{[\s\S]*?\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch (e) { /* continue */ }
  }
  // Fallback: greedy match for nested objects
  const greedyMatch = text.match(/\{[\s\S]*\}/);
  if (greedyMatch && greedyMatch[0] !== braceMatch?.[0]) {
    try { return JSON.parse(greedyMatch[0]); } catch (e) { /* continue */ }
  }
  return null;
}

class MediaPromptEngine {
  constructor(callAI) {
    this.callAI = callAI;
    this.scenarios = new Map(); // chatId -> scenario state
    this.promptModel = 'gemini-2.5-flash'; // fast & cheap for prompt generation
  }

  async generateImagePrompt(userRequest, context = {}) {
    // Skip if already professional
    if (isAlreadyProfessional(userRequest)) {
      const ctx = detectContext(userRequest);
      return {
        prompt: userRequest,
        model: selectImageModel({ style: 'photorealistic', sphere: ctx.sphere }),
        aspectRatio: '1:1',
        style: 'photorealistic',
        negativePrompt: 'blurry, low quality, watermark, text overlay, distorted, deformed',
        metadata: ctx,
        enhanced: false,
      };
    }

    const ctx = detectContext(userRequest);
    const contextHint = [
      ctx.sphere !== 'general' ? `Business sphere: ${ctx.sphere}` : '',
      ctx.theme !== 'general' ? `Theme: ${ctx.theme}` : '',
      ctx.locale ? `Location/culture: ${ctx.locale}` : '',
      ctx.language !== 'en' ? `Original language: ${ctx.language}` : '',
    ].filter(Boolean).join('. ');

    const userMsg = contextHint
      ? `${userRequest}\n\n[Context: ${contextHint}]`
      : userRequest;

    try {
      const result = await this.callAI(
        this.promptModel,
        [{ role: 'user', content: userMsg }],
        PHOTO_PROMPT_SYSTEM,
        false
      );

      const parsed = parseJSON(result?.text);
      if (!parsed || !parsed.prompt) {
        return this._fallbackImagePrompt(userRequest, ctx);
      }

      // Use engine's model recommendation or our heuristic
      const model = parsed.modelRecommendation || selectImageModel({
        style: parsed.style,
        sphere: ctx.sphere,
      });

      return {
        prompt: parsed.prompt,
        model,
        aspectRatio: parsed.aspectRatio || '1:1',
        style: parsed.style || 'photorealistic',
        negativePrompt: parsed.negativePrompt || 'blurry, low quality, watermark, distorted',
        metadata: { ...ctx, ...(parsed.metadata || {}) },
        enhanced: true,
      };
    } catch (e) {
      console.warn('[MediaPromptEngine] Image prompt generation failed:', e.message);
      return this._fallbackImagePrompt(userRequest, ctx);
    }
  }

  async generateVideoPrompt(userRequest, context = {}, options = {}) {
    if (isAlreadyProfessional(userRequest)) {
      const ctx = detectContext(userRequest);
      return {
        prompt: userRequest,
        model: selectVideoModel({ complexity: 'medium' }, options.hasEndFrame),
        duration: 8,
        aspectRatio: '16:9',
        resolution: '720p',
        negativePrompt: 'blurry, shaky, low quality, watermark, glitch, distorted',
        metadata: ctx,
        enhanced: false,
      };
    }

    const ctx = detectContext(userRequest);
    const contextHint = [
      ctx.sphere !== 'general' ? `Business sphere: ${ctx.sphere}` : '',
      ctx.theme !== 'general' ? `Theme: ${ctx.theme}` : '',
      ctx.locale ? `Location/culture: ${ctx.locale}` : '',
      options.hasStartFrame ? 'Start frame image is provided' : '',
      options.hasEndFrame ? 'End frame image is provided (A-to-B mode)' : '',
    ].filter(Boolean).join('. ');

    const userMsg = contextHint
      ? `${userRequest}\n\n[Context: ${contextHint}]`
      : userRequest;

    try {
      const result = await this.callAI(
        this.promptModel,
        [{ role: 'user', content: userMsg }],
        VIDEO_PROMPT_SYSTEM,
        false
      );

      const parsed = parseJSON(result?.text);
      if (!parsed || !parsed.prompt) {
        return this._fallbackVideoPrompt(userRequest, ctx, options);
      }

      const model = options.hasEndFrame
        ? 'veo-2'
        : (parsed.modelRecommendation || selectVideoModel(parsed.metadata || {}, false));

      return {
        prompt: parsed.prompt,
        model,
        duration: parsed.duration || 8,
        aspectRatio: parsed.aspectRatio || '16:9',
        resolution: parsed.resolution || '720p',
        negativePrompt: parsed.negativePrompt || 'blurry, shaky, low quality, watermark, glitch',
        metadata: { ...ctx, ...(parsed.metadata || {}) },
        enhanced: true,
      };
    } catch (e) {
      console.warn('[MediaPromptEngine] Video prompt generation failed:', e.message);
      return this._fallbackVideoPrompt(userRequest, ctx, options);
    }
  }

  async generateAnimationPrompt(userRequest, imageDescription) {
    const instruction = userRequest && userRequest.trim()
      ? `User wants: "${userRequest}". Image content: ${imageDescription || 'a still photograph'}`
      : `Animate this image naturally. Image content: ${imageDescription || 'a still photograph'}`;

    try {
      const result = await this.callAI(
        this.promptModel,
        [{ role: 'user', content: instruction }],
        ANIMATION_PROMPT_SYSTEM,
        false
      );

      const text = (result?.text || '').trim();
      if (text && text.length > 10 && text.length < 500) {
        return text;
      }
      return this._fallbackAnimationPrompt(imageDescription);
    } catch (e) {
      console.warn('[MediaPromptEngine] Animation prompt generation failed:', e.message);
      return this._fallbackAnimationPrompt(imageDescription);
    }
  }

  async generateScenario(userRequest, context = {}) {
    const ctx = detectContext(userRequest);
    const contextHint = [
      ctx.sphere !== 'general' ? `Business sphere: ${ctx.sphere}` : '',
      ctx.locale ? `Location/culture: ${ctx.locale}` : '',
    ].filter(Boolean).join('. ');

    const userMsg = contextHint
      ? `${userRequest}\n\n[Context: ${contextHint}]`
      : userRequest;

    try {
      const result = await this.callAI(
        this.promptModel,
        [{ role: 'user', content: userMsg }],
        SCENARIO_PROMPT_SYSTEM,
        false
      );

      const parsed = parseJSON(result?.text);
      if (!parsed || !parsed.frames || !Array.isArray(parsed.frames) || parsed.frames.length === 0) {
        throw new Error('Invalid scenario structure');
      }

      // Validate and enrich frames
      for (let i = 0; i < parsed.frames.length; i++) {
        const frame = parsed.frames[i];
        frame.id = i + 1;
        frame.duration = frame.duration || 8;
        frame.transition = frame.transition || 'cut';
      }

      parsed.totalFrames = parsed.frames.length;
      parsed.totalDuration = parsed.frames.reduce((sum, f) => sum + (f.duration || 8), 0);
      parsed.metadata = ctx;

      // Store for sequential generation
      if (context.chatId) {
        this.scenarios.set(context.chatId, {
          scenario: parsed,
          currentFrame: 0,
          generatedFrames: [],
          createdAt: Date.now(),
        });
      }

      return parsed;
    } catch (e) {
      console.warn('[MediaPromptEngine] Scenario generation failed:', e.message);
      throw new Error(`Failed to generate scenario: ${e.message}`);
    }
  }

  getNextFrame(chatId) {
    const state = this.scenarios.get(chatId);
    if (!state) return null;
    const { scenario, currentFrame } = state;
    if (currentFrame >= scenario.frames.length) return null;
    return scenario.frames[currentFrame];
  }

  advanceFrame(chatId, result) {
    const state = this.scenarios.get(chatId);
    if (!state) return;
    state.generatedFrames.push(result);
    state.currentFrame++;
  }

  getScenarioState(chatId) {
    return this.scenarios.get(chatId) || null;
  }

  clearScenario(chatId) {
    this.scenarios.delete(chatId);
  }

  // --- Fallbacks ---

  _fallbackImagePrompt(userRequest, ctx) {
    return {
      prompt: userRequest,
      model: selectImageModel({ style: 'photorealistic', sphere: ctx.sphere }),
      aspectRatio: '1:1',
      style: 'photorealistic',
      negativePrompt: 'blurry, low quality, watermark, text overlay, distorted, deformed',
      metadata: ctx,
      enhanced: false,
    };
  }

  _fallbackVideoPrompt(userRequest, ctx, options = {}) {
    return {
      prompt: userRequest,
      model: selectVideoModel({ complexity: 'medium' }, options.hasEndFrame),
      duration: 8,
      aspectRatio: '16:9',
      resolution: '720p',
      negativePrompt: 'blurry, shaky, low quality, watermark, glitch, distorted',
      metadata: ctx,
      enhanced: false,
    };
  }

  _fallbackAnimationPrompt(imageDescription) {
    return `Bring this image to life with subtle natural motion. Gentle camera push-in, soft parallax depth effect. ${
      imageDescription
        ? `The scene shows ${imageDescription} — add appropriate organic movement like gentle swaying, light shifts, and atmospheric particles.`
        : 'Add gentle breathing motion, subtle light changes, floating particles in the air, and soft environmental movement.'
    } Cinematic, smooth, photorealistic motion. 8 seconds.`;
  }
}

module.exports = { MediaPromptEngine, detectContext, isAlreadyProfessional };
