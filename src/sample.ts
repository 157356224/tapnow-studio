import type { StudioEdge, StudioNode, StudioNodeData } from './types';

export const models = {
  image: ['Seedream 5.0 Lite', 'Banana Pro', 'GPT Image', 'Seedream 5.0', 'FLUX.2', 'Imagen 4'],
  video: ['Seedance 2.0 Mini', 'Seedance 2.0 Fast'],
  text: ['Gemini 3.1 Flash Lite', 'Text Editor'],
  audio: ['Music / Voice', 'ElevenLabs', 'MiniMax Audio']
};
export const defaultVideoModel='Seedance 2.0 Mini';
export const supportedDoubaoVideoModels=['Seedance 2.0 Mini','Seedance 2.0 Fast'] as const;
export function normalizeVideoNodes(nodes:StudioNode[]):StudioNode[]{
  return nodes.map(node=>{
    if(node.data.kind==='image'&&node.data.provider==='demo')
      return {...node,data:{...node.data,provider:'muse'}};
    if(node.data.kind==='video'&&!models.video.includes(node.data.model||''))
      return {...node,data:{...node.data,model:defaultVideoModel}};
    return node;
  });
}
export const videoModelOptions=[
  {name:'Seedance 2.0 Mini',resolution:'720P',duration:'4–15S',audio:true},
  {name:'Seedance 2.0 Fast',resolution:'720P',duration:'4–15S',audio:true}
] as const;
export const kindLabels = { image: '图片', video: '视频', text: '文本', audio: '音频' };
export const kindEnglish = { image: 'Image', video: 'Video', text: 'Text', audio: 'Audio' };

export const demoImages = [
  'https://images.unsplash.com/photo-1531366936337-7c912a4589a7?w=760&auto=format&fit=crop&q=85',
  'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=760&auto=format&fit=crop&q=85',
  'https://images.unsplash.com/photo-1500534623283-312aade485b7?w=760&auto=format&fit=crop&q=85',
  'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=760&auto=format&fit=crop&q=85',
];
export function newData(kind: StudioNodeData['kind'], patch: Partial<StudioNodeData> = {}): StudioNodeData {
  const defaults: Record<StudioNodeData['kind'], string> = {
    text: '写下你的创意、脚本或提示词…',
    image: '描述画面、风格、构图、光线与细节…',
    video: '描述主体动作、镜头运动与场景变化…',
    audio: '描述音乐风格、节奏、情绪或旁白…'
  };
  return {
    kind, title: kindEnglish[kind], prompt: '', text: kind === 'text' ? '' : undefined,
    model: kind==='video'?defaultVideoModel:models[kind][0],
    provider:kind==='video'?'doubao':kind==='image'?'muse':undefined,
    ratio: kind==='image' ? '2:3' : '16:9',
    resolution:kind==='video'?'720p':'2K',
    duration: '5s', status: 'idle', progress: 0, color: '#a6c9f6',
    ...patch,
    placeholder: defaults[kind]
  };
}
export function sampleCanvas(): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const node = (id: string, x: number, y: number, data: StudioNodeData): StudioNode =>
    ({ id, type: 'studio', position: { x, y }, data });
  return {
    nodes: [
      node('story', -410, -42, newData('text', {
        title: '创意脚本', text: '在光与影的边界，构建一场未来感十足的视觉叙事。\n\n场景一 · 极光下的山谷\n镜头缓缓向前推进，冷色调的雾气围绕山峦。\n\n场景二 · 人物特写\n轻柔的光线掠过面部，情绪克制而神秘。',
      })),
      node('mountain', -10, -182, newData('image', {
        title: 'Image', mediaUrl: demoImages[0], demo: true,
        prompt: 'Cinematic mountain landscape under ethereal northern lights, soft haze, midnight blue palette, wide angle.',
        model: 'Banana Pro'
      })),
      node('portrait', 396, -30, newData('image', {
        title: 'Image', mediaUrl: demoImages[1], demo: true,
        prompt: 'Cinematic character portrait, natural skin texture, warm golden light, 85mm shallow depth of field.',
        model: 'Seedream 5.0', ratio: '3:4',
      })),
      node('film', 790, -158, newData('video', {
        title: 'Video', mediaUrl: demoImages[2], demo: true,
        prompt: 'A slow dolly in toward the landscape. Atmospheric mist drifts between the trees, cinematic camera movement.',
        model: defaultVideoModel, duration: '10s', resolution: '720P'
      })),
      node('sound', 790, 368, newData('audio', {
        title: 'Audio', prompt: 'Ambient cinematic soundtrack, gentle piano, airy pads, warm texture.', model: 'Music / Voice',
        demo: true
      }))
    ],
    edges: [
      { id: 'a', source: 'story', target: 'mountain', type: 'smoothstep' },
      { id: 'b', source: 'mountain', target: 'portrait', type: 'smoothstep' },
      { id: 'c', source: 'portrait', target: 'film', type: 'smoothstep' },
      { id: 'd', source: 'story', target: 'sound', type: 'smoothstep' }
    ]
  };
}

export function sampleAdCanvas(): { nodes: StudioNode[]; edges: StudioEdge[] } {
  return {
    nodes: [
      { id: 'ad-text', type: 'studio', position: { x: 0, y: 0 }, data: newData('text', {
        title: '产品创意', text: '主题：高端香水广告\n镜头：产品特写 → 氛围场景 → 品牌结尾\n画面：暖金色、高级影棚质感。'
      })},
      { id: 'ad-image', type: 'studio', position: { x: 405, y: -80 }, data: newData('image', {
        title: '产品主视觉', prompt: 'Luxury fragrance bottle, sophisticated golden lighting, studio photography, elegant shadows.',
        mediaUrl: demoImages[3], demo: true
      })},
      { id: 'ad-video', type: 'studio', position: { x: 820, y: -80 }, data: newData('video', {
        title: '广告视频', prompt: 'A smooth slow-motion orbit around a luxury perfume bottle with cinematic highlights.',
      })}
    ],
    edges: [
      { id: 'ad-1', source: 'ad-text', target: 'ad-image' },
      { id: 'ad-2', source: 'ad-image', target: 'ad-video' }
    ]
  };
}
