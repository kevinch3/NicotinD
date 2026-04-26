import { SlskdClient, type SlskdClientOptions } from './client.js';
import { SessionApi } from './api/session.js';
import { SearchesApi } from './api/searches.js';
import { TransfersApi } from './api/transfers.js';
import { ServerApi } from './api/server.js';
import { OptionsApi } from './api/options.js';
import { UsersApi } from './api/users.js';
import { ApplicationApi } from './api/application.js';
import { SharesApi } from './api/shares.js';

export class Slskd {
  private client: SlskdClient;

  public session: SessionApi;
  public searches: SearchesApi;
  public transfers: TransfersApi;
  public server: ServerApi;
  public options: OptionsApi;
  public users: UsersApi;
  public application: ApplicationApi;
  public shares: SharesApi;

  constructor(options: SlskdClientOptions) {
    this.client = new SlskdClient(options);
    this.session = new SessionApi(this.client);
    this.searches = new SearchesApi(this.client);
    this.transfers = new TransfersApi(this.client);
    this.server = new ServerApi(this.client);
    this.options = new OptionsApi(this.client);
    this.users = new UsersApi(this.client);
    this.application = new ApplicationApi(this.client);
    this.shares = new SharesApi(this.client, this.options);
  }
}

export { SlskdClient } from './client.js';
export type { SlskdClientOptions } from './client.js';
