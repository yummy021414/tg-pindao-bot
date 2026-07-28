// 用户账号数据库管理
import fs from 'fs';
import path from 'path';
import { UserAccountSession, AutoReplyConfig } from './types';

export class UserAccountDatabase {
  private dataPath: string;
  private data: {
    accounts: UserAccountSession[];
    autoReplyConfigs: AutoReplyConfig[];
    globalApiConfig?: { api_id: string; api_hash: string }; // 全局API配置
  } = { accounts: [], autoReplyConfigs: [] };

  constructor() {
    this.dataPath = path.resolve(__dirname, '../../data/user_accounts.json');
    this.ensureDataDirectory();
    this.loadData();
  }

  private ensureDataDirectory(): void {
    const dir = path.dirname(this.dataPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private loadData(): void {
    if (fs.existsSync(this.dataPath)) {
      try {
        const content = fs.readFileSync(this.dataPath, 'utf-8');
        this.data = JSON.parse(content);
      } catch (error) {
        console.error('加载用户账号数据失败:', error);
        this.data = { accounts: [], autoReplyConfigs: [] };
      }
    } else {
      this.data = { accounts: [], autoReplyConfigs: [] };
    }
  }

  private saveData(): void {
    try {
      fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (error) {
      console.error('保存用户账号数据失败:', error);
    }
  }

  // 账号管理
  async addAccount(account: Omit<UserAccountSession, 'id' | 'created_at'>): Promise<number> {
    const id = this.data.accounts.length > 0 
      ? Math.max(...this.data.accounts.map(a => a.id)) + 1 
      : 1;
    
    const newAccount: UserAccountSession = {
      ...account,
      id,
      created_at: new Date().toISOString()
    };

    this.data.accounts.push(newAccount);
    this.saveData();
    return id;
  }

  async getAccount(id: number): Promise<UserAccountSession | null> {
    return this.data.accounts.find(a => a.id === id) || null;
  }

  async getAllAccounts(): Promise<UserAccountSession[]> {
    return this.data.accounts;
  }

  async getActiveAccount(): Promise<UserAccountSession | null> {
    return this.data.accounts.find(a => a.is_active) || null;
  }

  async setActiveAccount(id: number): Promise<void> {
    // 先将所有账号设为非激活
    this.data.accounts.forEach(a => a.is_active = false);
    
    // 激活指定账号
    const account = this.data.accounts.find(a => a.id === id);
    if (account) {
      account.is_active = true;
      account.last_used_at = new Date().toISOString();
    }
    
    this.saveData();
  }

  async deleteAccount(id: number): Promise<void> {
    this.data.accounts = this.data.accounts.filter(a => a.id !== id);
    // 同时删除相关的自动回复配置
    this.data.autoReplyConfigs = this.data.autoReplyConfigs.filter(c => c.account_id !== id);
    this.saveData();
  }

  async updateAccountSession(id: number, session: string): Promise<void> {
    const account = this.data.accounts.find(a => a.id === id);
    if (account) {
      account.session = session;
      account.last_used_at = new Date().toISOString();
      this.saveData();
    }
  }

  async updateAccountPhone(id: number, phone: string): Promise<void> {
    const account = this.data.accounts.find(a => a.id === id);
    if (account) {
      account.phone = phone;
      account.last_used_at = new Date().toISOString();
      this.saveData();
    }
  }

  // 自动回复配置
  async setAutoReply(accountId: number, replyMessage: string, isEnabled: boolean = true): Promise<void> {
    const existing = this.data.autoReplyConfigs.find(c => c.account_id === accountId);
    
    if (existing) {
      existing.reply_message = replyMessage;
      existing.is_enabled = isEnabled;
      existing.updated_at = new Date().toISOString();
    } else {
      this.data.autoReplyConfigs.push({
        account_id: accountId,
        is_enabled: isEnabled,
        reply_message: replyMessage,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
    
    this.saveData();
  }

  async getAutoReply(accountId: number): Promise<AutoReplyConfig | null> {
    return this.data.autoReplyConfigs.find(c => c.account_id === accountId) || null;
  }

  async toggleAutoReply(accountId: number, enabled: boolean): Promise<void> {
    const config = this.data.autoReplyConfigs.find(c => c.account_id === accountId);
    if (config) {
      config.is_enabled = enabled;
      config.updated_at = new Date().toISOString();
      this.saveData();
    }
  }

  // 获取全局API配置（从已有账号或全局配置）
  async getApiConfig(): Promise<{ api_id: string; api_hash: string } | null> {
    // 优先使用全局配置
    if (this.data.globalApiConfig) {
      return this.data.globalApiConfig;
    }
    
    // 如果没有全局配置，尝试从已有账号中获取
    const existingAccount = this.data.accounts.find(a => a.api_id && a.api_hash);
    if (existingAccount) {
      return {
        api_id: existingAccount.api_id,
        api_hash: existingAccount.api_hash
      };
    }
    
    return null;
  }

  // 设置全局API配置
  async setGlobalApiConfig(api_id: string, api_hash: string): Promise<void> {
    this.data.globalApiConfig = { api_id, api_hash };
    this.saveData();
  }
}

export const userAccountDb = new UserAccountDatabase();

