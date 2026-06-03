/**
 * 哔哩哔哩必剪 ASR 语音识别服务
 * 当视频没有官方字幕时，直接将 B站 CDN 音频 URL 提交到必剪接口进行识别
 * 无需 API Key，依赖用户的 B站登录状态（credentials: 'include'）
 */

const API_BASE = 'https://member.bilibili.com/x/bcut/rubick-interface';
const API_REQ_UPLOAD = `${API_BASE}/resource/create`;
const API_COMMIT_UPLOAD = `${API_BASE}/resource/create/complete`;
const API_CREATE_TASK = `${API_BASE}/task`;
const API_QUERY_RESULT = `${API_BASE}/task/result`;

const MODEL_ID = '8';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 300_000; // 5 分钟超时
const AUDIO_DOWNLOAD_TIMEOUT_MS = 120_000;

const enum ResultState {
  STOP = 0,
  RUNNING = 1,
  ERROR = 3,
  COMPLETE = 4,
}

export interface BcutCaption {
  from: number;    // 秒
  to: number;      // 秒
  content: string;
}

interface BcutResourceCreateData {
  resource_id: string;
  in_boss_key: string;
  upload_urls: string[];
  upload_id: string;
  per_size: number;
}

export class BcutService {
  /**
   * 从播放信息中提取音频 CDN URL（m4s 格式）
   * 策略与 bilibili-mcp 同步：选最后一个（最高音质），优先 mcdn.bilivideo.cn
   */
  public static getAudioUrl(playUrlData: any): string | null {
    try {
      if (!playUrlData?.dash?.audio || !Array.isArray(playUrlData.dash.audio)) return null;
      const streams: any[] = playUrlData.dash.audio;
      const audio = streams[streams.length - 1];
      const allUrls: string[] = [audio.baseUrl, ...(audio.backupUrl || [])];
      for (const u of allUrls) {
        if (u.includes('.mcdn.bilivideo.cn')) return u;
      }
      return audio.baseUrl as string;
    } catch {
      return null;
    }
  }

  /**
   * 完整的 BCut ASR 转录流程：
   * 1. 提交任务（POST /task）
   * 2. 轮询结果（GET /task/result）
   * 3. 返回标准字幕格式
   */
  public static async transcribe(audioUrl: string): Promise<{ body: BcutCaption[] }> {
    try {
      return await BcutService.transcribeFromUrl(audioUrl);
    } catch (error) {
      console.warn('【VideoAdGuard】BCut URL 直传失败，尝试下载音频后上传:', error);
      return BcutService.transcribeFromDownloadedAudio(audioUrl);
    }
  }

  private static async transcribeFromUrl(audioUrl: string): Promise<{ body: BcutCaption[] }> {
    const taskId = await BcutService.createTask(audioUrl);
    const utterances = await BcutService.pollResult(taskId);
    return BcutService.toCaptionResult(utterances);
  }

  private static async transcribeFromDownloadedAudio(audioUrl: string): Promise<{ body: BcutCaption[] }> {
    const audio = await BcutService.downloadAudio(audioUrl);
    const resourceUrl = await BcutService.uploadAudio(audio.blob, audio.fileName, audio.fileType);
    const taskId = await BcutService.createTask(resourceUrl);
    const utterances = await BcutService.pollResult(taskId);
    return BcutService.toCaptionResult(utterances);
  }

  private static toCaptionResult(utterances: any[]): { body: BcutCaption[] } {
    const body: BcutCaption[] = utterances.map((u: any) => ({
      from: u.start_time / 1000,
      to: u.end_time / 1000,
      content: u.transcript as string,
    }));
    return { body };
  }

  private static async createTask(audioUrl: string): Promise<string> {
    const resp = await fetch(API_CREATE_TASK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ resource: audioUrl, model_id: MODEL_ID }),
    });
    if (!resp.ok) throw new Error(`BCut 创建任务失败: ${resp.status}`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(`BCut 创建任务错误: ${json.message}`);
    return json.data.task_id as string;
  }

  private static async downloadAudio(audioUrl: string): Promise<{ blob: Blob; fileName: string; fileType: string }> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), AUDIO_DOWNLOAD_TIMEOUT_MS);
    try {
      const resp = await fetch(audioUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.bilibili.com/',
        },
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`音频下载失败: ${resp.status}`);

      const blob = await resp.blob();
      const fileType = BcutService.getAudioFileType(audioUrl);
      return {
        blob,
        fileName: `${Date.now()}.${fileType}`,
        fileType,
      };
    } finally {
      window.clearTimeout(timer);
    }
  }

  private static getAudioFileType(audioUrl: string): string {
    try {
      const path = new URL(audioUrl).pathname;
      const match = path.match(/\.([a-z0-9]+)$/i);
      const suffix = match?.[1]?.toLowerCase() || 'm4s';
      return suffix === 'm4s' ? 'm4a' : suffix;
    } catch {
      return 'm4a';
    }
  }

  private static async uploadAudio(blob: Blob, fileName: string, fileType: string): Promise<string> {
    const resource = await BcutService.requestUpload(blob, fileName, fileType);
    const etags = await BcutService.uploadParts(blob, resource);
    return BcutService.commitUpload(resource, etags);
  }

  private static async requestUpload(blob: Blob, fileName: string, fileType: string): Promise<BcutResourceCreateData> {
    const form = new URLSearchParams({
      type: '2',
      name: fileName,
      size: String(blob.size),
      resource_file_type: fileType,
      model_id: MODEL_ID,
    });

    const resp = await fetch(API_REQ_UPLOAD, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      credentials: 'include',
      body: form.toString(),
    });
    if (!resp.ok) throw new Error(`BCut 申请上传失败: ${resp.status}`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(`BCut 申请上传错误: ${json.message}`);
    return json.data as BcutResourceCreateData;
  }

  private static async uploadParts(blob: Blob, resource: BcutResourceCreateData): Promise<string[]> {
    const etags: string[] = [];
    for (let index = 0; index < resource.upload_urls.length; index += 1) {
      const start = index * resource.per_size;
      const end = Math.min(start + resource.per_size, blob.size);
      const part = blob.slice(start, end);
      const uploadUrl = BcutService.normalizeUploadUrl(resource.upload_urls[index]);
      const resp = await fetch(uploadUrl, {
        method: 'PUT',
        body: part,
      });
      if (!resp.ok) throw new Error(`BCut 上传分片失败: ${resp.status}`);
      etags.push(resp.headers.get('Etag') || resp.headers.get('ETag') || '');
    }
    return etags;
  }

  private static normalizeUploadUrl(url: string): string {
    if (url.startsWith('http://')) {
      return `https://${url.slice('http://'.length)}`;
    }
    return url;
  }

  private static async commitUpload(resource: BcutResourceCreateData, etags: string[]): Promise<string> {
    const form = new URLSearchParams({
      in_boss_key: resource.in_boss_key,
      resource_id: resource.resource_id,
      etags: etags.join(','),
      upload_id: resource.upload_id,
      model_id: MODEL_ID,
    });

    const resp = await fetch(API_COMMIT_UPLOAD, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      credentials: 'include',
      body: form.toString(),
    });
    if (!resp.ok) throw new Error(`BCut 提交上传失败: ${resp.status}`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(`BCut 提交上传错误: ${json.message}`);
    return json.data.download_url as string;
  }

  private static async pollResult(taskId: string): Promise<any[]> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      const url = `${API_QUERY_RESULT}?model_id=${MODEL_ID}&task_id=${encodeURIComponent(taskId)}`;
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`BCut 查询结果失败: ${resp.status}`);
      const json = await resp.json();
      if (json.code !== 0) throw new Error(`BCut 查询结果错误: ${json.message}`);
      const { state, result, remark } = json.data;
      switch (state) {
        case ResultState.COMPLETE: {
          const parsed = JSON.parse(result);
          return parsed.utterances as any[];
        }
        case ResultState.ERROR:
          throw new Error(`BCut 识别失败: ${remark || '未知错误'}`);
        // STOP / RUNNING → 继续轮询
      }
    }
    throw new Error('BCut 语音识别超时（超过 5 分钟）');
  }
}
