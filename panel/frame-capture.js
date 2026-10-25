import {fmtTime} from '../lib/prompts.js';

export function parseTime(text) {
  const value = String(text).trim();
  if (!/^\d+(?::[0-5]\d){0,2}$/.test(value)) throw new Error('时间格式请填写秒数、分:秒或时:分:秒，例如 03:20。');
  return value.split(':').reduce((total, n) => total * 60 + Number(n), 0);
}
export function sampleTimes(start, end, count, duration) {
  if (![start,end,count,duration].every(Number.isFinite) || start < 0 || end <= start || end > duration || !Number.isInteger(count) || count < 2 || count > 8) throw new Error('请选择有效的起止时间（结束时间不能超过视频时长），采样数量为 2~8 帧。');
  return Array.from({length:count}, (_, i) => Math.min(duration - .05, start + (end-start)*i/(count-1)));
}

// Runs in the extension's isolated world. Retain the exact video element for restoration.
export async function playerOperation(action, time) {
  const slot = '__videoAiFrameSession';
  if (action === 'begin') {
    if (globalThis[slot]) throw new Error('已有识屏任务正在采样。');
    const videos = [...document.querySelectorAll('video')].filter(v => v.getBoundingClientRect().width > 100);
    const video = videos.sort((a,b) => b.getBoundingClientRect().width*b.getBoundingClientRect().height - a.getBoundingClientRect().width*a.getBoundingClientRect().height)[0];
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) throw new Error('未找到已加载的视频，直播和未加载的播放器暂不支持。');
    globalThis[slot] = {video,time:video.currentTime,paused:video.paused,src:video.currentSrc};
    video.pause();
    return {duration:video.duration};
  }
  const state = globalThis[slot];
  if (!state) throw new Error('播放器已切换，请重新采样。');
  const v = state.video;
  if (action === 'restore') {
    delete globalThis[slot];
    if (v.isConnected && v.currentSrc === state.src) {
      v.currentTime = state.time;
      if (!state.paused) await v.play().catch(() => {});
    }
    return;
  }
  if (!v.isConnected || v.currentSrc !== state.src) throw new Error('采样过程中视频已切换。');
  if (document.visibilityState !== 'visible') throw new Error('请保持视频标签页在前台。');
  v.pause();
  if (Math.abs(v.currentTime-time) > .02 || v.seeking || v.readyState < 2) {
    await new Promise((resolve,reject) => {
      const clean = () => {clearTimeout(timer);v.removeEventListener('seeked',ready);v.removeEventListener('loadeddata',ready);};
      const ready = () => {if(!v.seeking && v.readyState >= 2) {clean();resolve();}};
      const timer = setTimeout(() => {clean();reject(new Error('视频跳转超时，请先播放目标区间后重试。'));},15000);
      v.addEventListener('seeked',ready);v.addEventListener('loadeddata',ready);
      v.currentTime = time;
      ready();
    });
  }
  await new Promise(resolve => setTimeout(resolve,250));
  if (Math.abs(v.currentTime-time) > .6) throw new Error('播放器未到达目标时间，已取消识屏。');
  try {
    if (!v.videoWidth || !v.videoHeight) throw new Error('画面尚未解码');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1,1280/v.videoWidth);
    canvas.width = Math.round(v.videoWidth*scale);canvas.height = Math.round(v.videoHeight*scale);
    canvas.getContext('2d').drawImage(v,0,0,canvas.width,canvas.height);
    return {url:canvas.toDataURL('image/jpeg',.8),actual:v.currentTime};
  } catch {
    const r = v.getBoundingClientRect();
    if(r.x < 0 || r.y < 0 || r.right > innerWidth || r.bottom > innerHeight || r.width < 100 || r.height < 50) throw new Error('请让视频画面完整显示在页面中，再使用识屏。');
    return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},actual:v.currentTime};
  }
}

export async function captureFrames({tabId,start,end,count,signal,onProgress}) {
  const run = async (action,time) => {
    const [result] = await chrome.scripting.executeScript({target:{tabId},func:playerOperation,args:[action,time ?? 0]});
    if (result?.error) throw new Error(result.error.message || '播放器操作失败');
    if (!result) throw new Error('未能连接播放器');
    return result.result;
  };
  const ensureActive = async () => {
    signal?.throwIfAborted();
    const [active] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
    if (active?.id !== tabId) throw new Error('请保持原视频标签页在前台，采样已取消。');
    return active;
  };
  let began = false;
  try {
    await ensureActive();
    const {duration} = await run('begin');began = true;
    const frames=[];
    for (const time of sampleTimes(start,end,count,duration)) {
      const tab = await ensureActive();
      onProgress?.(`正在采样 ${frames.length+1}/${count} · ${fmtTime(time)}…`);
      const data = await run('frame',time);
      await ensureActive();
      let url = data.url;
      if (!url) {
        let screenshot;
        try {screenshot = await chrome.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:85});}
        catch {throw new Error('请先点击 Edge 工具栏上的本扩展图标以授权识屏，然后重试。');}
        await ensureActive();
        const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
        try {
          const sx=bitmap.width/data.viewport.width,sy=bitmap.height/data.viewport.height,r=data.rect;
          const width=Math.min(1280,Math.round(r.width*sx)),height=Math.round(width*r.height/r.width);
          const canvas=new OffscreenCanvas(width,height);
          canvas.getContext('2d').drawImage(bitmap,r.x*sx,r.y*sy,r.width*sx,r.height*sy,0,0,width,height);
          const blob=await canvas.convertToBlob({type:'image/jpeg',quality:.8});
          url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
        } finally {bitmap.close();}
      }
      signal?.throwIfAborted();
      frames.push({time:fmtTime(data.actual),url});
      // Stay below captureVisibleTab's two calls per second limit.
      await new Promise(resolve => setTimeout(resolve,550));
    }
    return frames;
  } finally {
    if (began) await run('restore').catch(() => {});
  }
}
