import { MediaItem, UserPermission, UserSession, PermissionType } from '../types';
import {
  AndroidAppContent,
  AndroidAppUser,
  AndroidCircleLead,
  AndroidClaimResult,
  AndroidNoteSyncPayload,
  AndroidSendAction,
  AndroidSendGuardOptions,
  AndroidSendQuota,
  AndroidSendTask,
  JsonDatabase
} from './json-database';

export class Database {
  private jsonDb: JsonDatabase;

  constructor() {
    // 使用 JSON 数据库替代 SQLite
    this.jsonDb = new JsonDatabase();
  }

  // 媒体相关方法
  async saveMedia(media: Omit<MediaItem, 'id'>): Promise<number> {
    return this.jsonDb.saveMedia(media);
  }

  async getMediaByKeyword(keyword: string, userId?: number): Promise<MediaItem[]> {
    return this.jsonDb.getMediaByKeyword(keyword, userId);
  }

  async getReviewsByKeyword(keyword: string): Promise<MediaItem[]> {
    return this.jsonDb.getReviewsByKeyword(keyword);
  }

  async getKeywordsWithReviews(): Promise<string[]> {
    return this.jsonDb.getKeywordsWithReviews();
  }

  async getAllMedia(userId?: number): Promise<MediaItem[]> {
    return this.jsonDb.getAllMedia(userId);
  }

  async deleteMedia(id: number): Promise<void> {
    return this.jsonDb.deleteMedia(id);
  }

  async updateMediaPublished(id: number, channelId: string): Promise<void> {
    return this.jsonDb.updateMediaPublished(id, channelId);
  }

  async getPublishedKeywordsByTimeRange(
    userId: number,
    start: Date,
    end: Date,
    channelIds?: string[]
  ): Promise<Array<{ keyword: string; publishedAt: string; channelId?: string; legacy?: boolean; fallback?: boolean; matchBy?: string }>> {
    return this.jsonDb.getPublishedKeywordsByTimeRange(userId, start, end, channelIds);
  }

  async getPublishExtractStats(userId: number, channelIds?: string[]) {
    return this.jsonDb.getPublishExtractStats(userId, channelIds);
  }

  async updateMediaSource(
    id: number,
    chatId: string,
    msgId: number,
    options?: { force?: boolean }
  ): Promise<void> {
    return this.jsonDb.updateMediaSource(id, chatId, msgId, options);
  }

  async updateMediaFileId(id: number, fileId: string, fileType?: MediaItem['file_type']): Promise<void> {
    return this.jsonDb.updateMediaFileId(id, fileId, fileType);
  }

  async batchUpdateMediaFileIds(
    updates: Array<{ id: number; fileId: string; fileType?: MediaItem['file_type'] }>
  ): Promise<number> {
    return this.jsonDb.batchUpdateMediaFileIds(updates);
  }

  async getMediaCount(userId?: number): Promise<number> {
    return this.jsonDb.getMediaCount(userId);
  }

  async cleanInvalidMedia(): Promise<number> {
    return this.jsonDb.cleanInvalidMedia();
  }

  // 用户权限相关方法
  async getUserPermissions(userId: number): Promise<UserPermission[]> {
    return this.jsonDb.getUserPermissions(userId);
  }

  async grantUserPermission(userId: number, type: PermissionType, days?: number): Promise<void> {
    return this.jsonDb.addUserPermission(userId, type, days);
  }

  async checkAlbumAccess(userId: number): Promise<{ hasAccess: boolean; status: string; remainingDays?: number }> {
    return this.jsonDb.checkAlbumAccess(userId);
  }

  async revokeUserPermission(userId: number, type: string): Promise<void> {
    return this.jsonDb.revokeUserPermission(userId, type);
  }

  async getAllUserPermissions(): Promise<UserPermission[]> {
    return this.jsonDb.getAllUserPermissions();
  }

  async getExpiringUsers(): Promise<any[]> {
    return this.jsonDb.getExpiringUsers();
  }

  async markReminderSent(userId: number): Promise<void> {
    return this.jsonDb.markReminderSent(userId);
  }

  // 用户会话相关方法
  async saveUserSession(userId: number, session: UserSession): Promise<void> {
    return this.jsonDb.saveUserSession(userId, session);
  }

  async getUserSession(userId: number): Promise<UserSession | null> {
    return this.jsonDb.getUserSession(userId);
  }

  async clearUserSession(userId: number): Promise<void> {
    return this.jsonDb.clearUserSession(userId);
  }

  async trackUser(userId: number, first_name?: string, last_name?: string, username?: string): Promise<void> {
    return this.jsonDb.trackUser(userId, first_name, last_name, username);
  }

  async removeUser(userId: number): Promise<void> {
    return this.jsonDb.removeUser(userId);
  }

  async getChatUsers(): Promise<any[]> {
    return this.jsonDb.getChatUsers();
  }

  async saveChatMessage(userId: number, messageId: number, content: string): Promise<void> {
    return this.jsonDb.saveChatMessage(userId, messageId, content);
  }

  async getAllActiveUsers(): Promise<any[]> {
    return this.jsonDb.getAllActiveUsers();
  }

  async getKeywordCount(): Promise<number> {
    return this.jsonDb.getKeywordCount();
  }

  async getJoinWelcomeConfig(): Promise<any> {
    return this.jsonDb.getJoinWelcomeConfig();
  }

  async saveJoinWelcomeConfig(config: any): Promise<void> {
    return this.jsonDb.saveJoinWelcomeConfig(config);
  }

  async getManagedChannels(): Promise<string[]> {
    return this.jsonDb.getManagedChannels();
  }

  async addManagedChannel(channelId: string): Promise<void> {
    return this.jsonDb.addManagedChannel(channelId);
  }

  async removeManagedChannel(channelId: string): Promise<boolean> {
    return this.jsonDb.removeManagedChannel(channelId);
  }

  async saveAlbum(albumId: string, albumData: any): Promise<void> {
    return this.jsonDb.saveAlbum(albumId, albumData);
  }

  async getAlbum(albumId: string): Promise<any> {
    return this.jsonDb.getAlbum(albumId);
  }

  async getRecommendedTags(): Promise<string[]> {
    return this.jsonDb.getRecommendedTags();
  }

  async saveRecommendedTags(tags: string[]): Promise<void> {
    return this.jsonDb.saveRecommendedTags(tags);
  }

  async getUserAlbums(userId: number): Promise<any[]> {
    return this.jsonDb.getUserAlbums(userId);
  }

  async getAllAlbums(): Promise<any[]> {
    return this.jsonDb.getAllAlbums();
  }

  async deleteAlbum(albumId: string): Promise<void> {
    return this.jsonDb.deleteAlbum(albumId);
  }

  async getExpiredAlbums(days: number = 3): Promise<any[]> {
    return this.jsonDb.getExpiredAlbums(days);
  }

  async upsertAndroidAppUser(input: Omit<AndroidAppUser, 'createdAt' | 'updatedAt'>): Promise<AndroidAppUser> {
    return this.jsonDb.upsertAndroidAppUser(input);
  }

  async upsertAndroidAppContent(input: Omit<AndroidAppContent, 'createdAt' | 'updatedAt'>): Promise<AndroidAppContent> {
    return this.jsonDb.upsertAndroidAppContent(input);
  }

  async getAndroidAppUser(appUserId: string): Promise<AndroidAppUser | null> {
    return this.jsonDb.getAndroidAppUser(appUserId);
  }

  async getAndroidAppContentByKeyword(tgKeyword: string): Promise<AndroidAppContent | null> {
    return this.jsonDb.getAndroidAppContentByKeyword(tgKeyword);
  }

  async listAndroidMappings(): Promise<{ users: AndroidAppUser[]; contents: AndroidAppContent[] }> {
    return this.jsonDb.listAndroidMappings();
  }

  async createAndroidSendTasks(appUser: AndroidAppUser, contents: AndroidAppContent[], requestedByChatId: number, action?: AndroidSendAction): Promise<AndroidSendTask[]> {
    return this.jsonDb.createAndroidSendTasks(appUser, contents, requestedByChatId, action);
  }

  async createAndroidNoteSyncTask(payload: AndroidNoteSyncPayload, requestedByChatId: number): Promise<AndroidSendTask> {
    return this.jsonDb.createAndroidNoteSyncTask(payload, requestedByChatId);
  }

  async getAndroidNoteSyncOnUpload(defaultValue: boolean): Promise<boolean> {
    return this.jsonDb.getAndroidNoteSyncOnUpload(defaultValue);
  }

  async setAndroidNoteSyncOnUpload(value: boolean): Promise<void> {
    return this.jsonDb.setAndroidNoteSyncOnUpload(value);
  }

  async claimNextAndroidSendTask(workerId: string, options: AndroidSendGuardOptions): Promise<AndroidClaimResult> {
    return this.jsonDb.claimNextAndroidSendTask(workerId, options);
  }

  async completeAndroidSendTask(
    taskId: string,
    workerId: string,
    claimToken: string,
    success: boolean,
    errorMessage?: string,
    cooldown?: { minIntervalMs: number; maxIntervalMs: number }
  ): Promise<AndroidSendTask> {
    return this.jsonDb.completeAndroidSendTask(taskId, workerId, claimToken, success, errorMessage, cooldown);
  }

  async getAndroidSendQuota(dailyLimit: number): Promise<AndroidSendQuota> {
    return this.jsonDb.getAndroidSendQuota(dailyLimit);
  }

  async listAndroidSendTasks(limit: number = 20): Promise<AndroidSendTask[]> {
    return this.jsonDb.listAndroidSendTasks(limit);
  }

  async saveAndroidCircleLead(input: Omit<AndroidCircleLead, 'leadId' | 'capturedAt' | 'botChatId' | 'botMessageId'>) {
    return this.jsonDb.saveAndroidCircleLead(input);
  }

  async bindAndroidCircleLeadToBotMessage(leadId: string, botChatId: number, botMessageId: number): Promise<void> {
    return this.jsonDb.bindAndroidCircleLeadToBotMessage(leadId, botChatId, botMessageId);
  }

  async getAndroidCircleLeadByBotMessage(botChatId: number, botMessageId: number): Promise<AndroidCircleLead | null> {
    return this.jsonDb.getAndroidCircleLeadByBotMessage(botChatId, botMessageId);
  }

  async getAndroidCircleLead(leadId: string): Promise<AndroidCircleLead | null> {
    return this.jsonDb.getAndroidCircleLead(leadId);
  }

  async listAndroidCircleLeads(limit = 20): Promise<AndroidCircleLead[]> {
    return this.jsonDb.listAndroidCircleLeads(limit);
  }

  async createAndroidSendTasksForCircleLead(leadId: string, contents: AndroidAppContent[], requestedByChatId: number, action: AndroidSendAction): Promise<AndroidSendTask[]> {
    return this.jsonDb.createAndroidSendTasksForCircleLead(leadId, contents, requestedByChatId, action);
  }

  async close(): Promise<void> {
    return this.jsonDb.close();
  }

  // 添加缺失的方法
  async checkUserPermission(userId: number): Promise<boolean> {
    return this.jsonDb.checkUserPermission(userId);
  }

  async searchMedia(keyword: string, userId?: number, limit?: number): Promise<MediaItem[]> {
    return this.jsonDb.searchMedia(keyword, userId, limit);
  }

  async getMediaStats(): Promise<any> {
    return this.jsonDb.getMediaStats();
  }

  async getAllKeywords(userId?: number): Promise<string[]> {
    return this.jsonDb.getAllKeywords(userId);
  }

  async keywordExists(keyword: string, userId?: number): Promise<boolean> {
    return this.jsonDb.keywordExists(keyword, userId);
  }

  async deleteKeyword(keyword: string, userId?: number): Promise<number> {
    return this.jsonDb.deleteKeyword(keyword, userId);
  }

  async getUserCount(): Promise<number> {
    return this.jsonDb.getUserCount();
  }

  async getUserInfo(userId: number): Promise<any> {
    return this.jsonDb.getUserInfo(userId);
  }

  async startAlbumTrial(userId: number): Promise<void> {
    return this.jsonDb.startAlbumTrial(userId);
  }

  async grantAlbumAuth(userId: number, months: number): Promise<void> {
    return this.jsonDb.grantAlbumAuth(userId, months);
  }

  async saveImmediately(): Promise<void> {
    return this.jsonDb.saveImmediately();
  }
}

// 创建数据库实例
export const database = new Database();
