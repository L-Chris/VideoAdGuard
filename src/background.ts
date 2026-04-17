/**
 * Background Script - 后台脚本
 * 负责处理跨域请求和 LLM API 调用
 */

import { STORAGE_KEYS } from './services/llm/config';
import { LLMGateway } from './services/llm/providers';
import { LLMInvokePayload, StoredLLMSettings } from './services/llm/types';
import { createHttpError, normalizeErrorForUser } from './utils/errors';

export {}

// 消息类型枚举
enum MessageType {
  LLM_INVOKE = 'LLM_INVOKE',
  API_REQUEST = 'API_REQUEST'
}

// 响应接口
interface ApiResponse {
  success: boolean;
  data?: any;
  error?: string;
}

// 消息处理器类
class MessageHandler {
  /**
   * 处理来自content script的消息
   */
  static handleMessage(message: any, _sender: chrome.runtime.MessageSender, sendResponse: (response: ApiResponse) => void): boolean {
    try {
      // 处理模型调用请求
      if (message.type === MessageType.LLM_INVOKE) {
        LLMInvokeHandler.handle(message, sendResponse);
        return true; // 异步响应
      }

      // 处理通用API请求
      if (MessageHandler.isApiRequest(message)) {
        ApiRequestHandler.handle(message, sendResponse);
        return true; // 异步响应
      }

      // 无效消息结构
      sendResponse({ success: false, error: "Invalid message structure" });
      return false;
    } catch (error) {
      console.warn('【VideoAdGuard】[Background] 消息处理失败:', error);
      sendResponse({
        success: false,
        error: normalizeErrorForUser(error)
      });
      return false;
    }
  }

  /**
   * 检查是否为API请求
   */
  private static isApiRequest(message: any): boolean {
    if (message?.type === MessageType.API_REQUEST) {
      return Boolean(message?.data?.url && message?.data?.headers && message?.data?.body);
    }
    return Boolean(message?.url && message?.headers && message?.body);
  }
}

// 通用API请求处理器
class ApiRequestHandler {
  /**
   * 处理通用API请求
   */
  static async handle(message: any, sendResponse: (response: ApiResponse) => void): Promise<void> {
    try {
      const payload = message?.type === MessageType.API_REQUEST ? message.data : message;
      const { url, headers, body } = payload;

      if (!url) {
        throw new Error('请求地址为空');
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw await createHttpError(response, '请求失败');
      }

      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/json')
        ? await response.json()
        : await response.text();
      sendResponse({ success: true, data });
    } catch (error) {
      console.warn('【VideoAdGuard】[Background] API请求失败:', error);
      sendResponse({
        success: false,
        error: normalizeErrorForUser(error, 'network')
      });
    }
  }
}

class LLMInvokeHandler {
  static async handle(message: any, sendResponse: (response: ApiResponse) => void): Promise<void> {
    try {
      const payload = message?.payload as Partial<LLMInvokePayload> | undefined;

      if (!payload || typeof payload.systemPrompt !== 'string' || typeof payload.userPrompt !== 'string') {
        throw new Error('模型请求参数无效');
      }

      const storedSettings = (await chrome.storage.local.get(
        [...STORAGE_KEYS]
      )) as StoredLLMSettings;

      const result = await LLMGateway.invoke(
        {
          systemPrompt: payload.systemPrompt,
          userPrompt: payload.userPrompt,
          responseFormat: payload.responseFormat === 'text' ? 'text' : 'json',
          maxTokens: typeof payload.maxTokens === 'number' ? payload.maxTokens : 1024,
          temperature: typeof payload.temperature === 'number' ? payload.temperature : 0,
        },
        storedSettings
      );

      sendResponse({ success: true, data: result });
    } catch (error) {
      console.warn('【VideoAdGuard】[Background] 模型请求失败:', error);
      sendResponse({
        success: false,
        error: normalizeErrorForUser(error, 'llm')
      });
    }
  }
}

// 注册消息监听器
chrome.runtime.onMessage.addListener(MessageHandler.handleMessage);






