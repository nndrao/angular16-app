import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';

import { AppModule } from './app/app.module';

// Import AG-Grid Enterprise to enable enterprise features including Status Bar
import 'ag-grid-enterprise';
import { LicenseManager } from 'ag-grid-enterprise';

// Set your license key here (or use evaluation mode)
// For production, store this in environment variables
// LicenseManager.setLicenseKey('YOUR_LICENSE_KEY');
// Note: Without a license key, AG-Grid Enterprise runs in evaluation mode with a watermark

platformBrowserDynamic().bootstrapModule(AppModule)
  .catch(err => console.error(err));
