import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';

interface ContaboConfig {
  clientId: string;
  clientSecret: string;
  apiUser: string;
  apiPassword: string;
}

interface ContaboAuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface ContaboInstance {
  instanceId: number;
  displayName: string;
  name: string;
  status: string;
  region: string;
  productId: string;
  ipConfig: {
    v4?: {
      ip: string;
    };
  };
  createdDate: string;
}

export class ContaboClient {
  private config: ContaboConfig;
  private client: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(config: ContaboConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: 'https://api.contabo.com',
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Authenticate with Contabo API and get access token
   */
  public async authenticate(): Promise<string> {
    // Return cached token if still valid
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const response = await axios.post<ContaboAuthResponse>(
        'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
        new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          username: this.config.apiUser,
          password: this.config.apiPassword,
          grant_type: 'password',
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      this.accessToken = response.data.access_token;
      // Set expiry to 5 minutes before actual expiry for safety
      this.tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;

      if (!this.accessToken) {
        throw new Error('Failed to obtain access token from Contabo');
      }
      return this.accessToken;
    } catch (error: any) {
      console.error('Contabo authentication failed:', error.response?.data || error.message);
      throw new Error(`Failed to authenticate with Contabo: ${error.response?.data?.error_description || error.message}`);
    }
  }

  /**
   * Make authenticated request to Contabo API
   */
  private async request<T>(method: string, endpoint: string, data?: any): Promise<T> {
    const token = await this.authenticate();

    // Generate unique request ID for Contabo API requirement (must be UUID4)
    const requestId = uuidv4();

    try {
      const response = await this.client.request<T>({
        method,
        url: endpoint,
        data,
        headers: {
          Authorization: `Bearer ${token}`,
          'x-request-id': requestId,
        },
      });

      return response.data;
    } catch (error: any) {
      console.error(`Contabo API request failed: ${method} ${endpoint}`, error.response?.data || error.message);
      throw new Error(`Contabo API error: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Get available images
   */
  async getImages() {
    return this.request('GET', '/v1/compute/images');
  }

  /**
   * Get available instance products
   * Note: Contabo doesn't expose a public products listing endpoint.
   * Use hardcoded product IDs: V45 (solo), V46 (team), V47 (enterprise)
   */
  async getProducts() {
    // Return hardcoded product information since API doesn't expose this endpoint
    return {
      data: [
        { productId: 'V45', name: 'VPS S SSD', cpu: 4, ram: '8 GB', disk: '200 GB SSD', description: 'Solo plan' },
        { productId: 'V46', name: 'VPS M SSD', cpu: 6, ram: '16 GB', disk: '400 GB SSD', description: 'Team plan' },
        { productId: 'V47', name: 'VPS L SSD', cpu: 8, ram: '30 GB', disk: '800 GB SSD', description: 'Enterprise plan' },
      ]
    };
  }

  /**
   * List secrets
   */
  async listSecrets(type?: 'ssh' | 'password'): Promise<any> {
    const params = type ? `?type=${type}` : '';
    return this.request('GET', `/v1/secrets${params}`);
  }

  /**
   * Create a new secret
   */
  async createSecret(params: {
    name: string;
    value: string;
    type: 'ssh' | 'password';
  }): Promise<any> {
    return this.request('POST', '/v1/secrets', params);
  }

  /**
   * Get or create SSH key secret
   */
  async getOrCreateSshKeySecret(name: string, publicKey: string): Promise<number> {
    // List existing SSH secrets
    const response = await this.listSecrets('ssh');
    const existingSecret = response.data?.find((s: any) => s.name === name);

    if (existingSecret) {
      return existingSecret.secretId;
    }

    // Create new secret
    const newSecret = await this.createSecret({
      name,
      value: publicKey,
      type: 'ssh',
    });

    return newSecret.data[0].secretId;
  }

  /**
   * Create a new VPS instance
   */
  async createInstance(params: {
    productId: string;
    region: string;
    imageId: string;
    displayName: string;
    userData?: string;
    period?: number;
    sshKeys?: number[];
  }): Promise<any> {
    return this.request('POST', '/v1/compute/instances', {
      productId: params.productId,
      region: params.region,
      imageId: params.imageId,
      displayName: params.displayName,
      userData: params.userData,
      period: params.period || 1, // 1 month minimum
      sshKeys: params.sshKeys || [],
    });
  }

  /**
   * Get instance details
   */
  async getInstance(instanceId: string | number): Promise<ContaboInstance> {
    const response = await this.request<{ data: ContaboInstance[] }>('GET', `/v1/compute/instances/${instanceId}`);
    return response.data[0];
  }

  /**
   * Delete an instance
   */
  async deleteInstance(instanceId: string | number): Promise<void> {
    await this.request('DELETE', `/v1/compute/instances/${instanceId}`);
  }

  /**
   * List all instances
   */
  async listInstances(): Promise<ContaboInstance[]> {
    const response = await this.request<{ data: ContaboInstance[] }>('GET', '/v1/compute/instances');
    return response.data;
  }

  /**
   * Get instance status
   */
  async getInstanceStatus(instanceId: string | number): Promise<string> {
    const instance = await this.getInstance(instanceId);
    return instance.status;
  }
}

/**
 * Create a Contabo client from environment variables
 */
export function createContaboClient(): ContaboClient {
  const config = {
    clientId: process.env.CONTABO_CLIENT_ID!,
    clientSecret: process.env.CONTABO_CLIENT_SECRET!,
    apiUser: process.env.CONTABO_API_USER!,
    apiPassword: process.env.CONTABO_API_PASSWORD!,
  };


  if (!config.clientId || !config.clientSecret || !config.apiUser || !config.apiPassword) {
    throw new Error('Missing Contabo API credentials in environment variables');
  }

  return new ContaboClient(config);
}
