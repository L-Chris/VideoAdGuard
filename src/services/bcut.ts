/**
 * 哔哩哔哩必剪 ASR 语音识别服务
 * 当视频没有官方字幕时，直接将 B站 CDN 音频 URL 提交到必剪接口进行识别
 * 无需 API Key，依赖用户的 B站登录状态（credentials: 'include'）
 */

const API_BASE = 'https://member.bilibili.com/x/bcut/rubick-interface';
const API_CREATE_TASK = `${API_BASE}/task`;
const API_QUERY_RESULT = `${API_BASE}/task/result`;

const MODEL_ID = '8';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 300_000; // 5 分钟超时

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

export class BcutService {
  /**
   * 从播放信息中提取带宽最低的音频 CDN URL（m4s 格式）
   */
  public static getAudioUrl(playUrlData: any): string | null {
    try {
      if (!playUrlData?.dash?.audio || !Array.isArray(playUrlData.dash.audio)) return null;
      const streams: any[] = playUrlData.dash.audio;
      let min = streams[0];
      for (const s of streams) if (s.bandwidth < min.bandwidth) min = s;
      return min.baseUrl as string;
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
    const taskId = await BcutService.createTask(audioUrl);
    const utterances = await BcutService.pollResult(taskId);
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
