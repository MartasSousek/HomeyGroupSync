/* eslint-disable import/no-extraneous-dependencies */
import Homey from 'homey';
import { HomeyAPIV3 } from 'homey-api';

type HomeyDevice = {
  id: string;
  name: string;
  class: string;
  virtualClass?: string;
  zone: string;
  group?: string;
  capabilitiesObj: {
    onoff?: {
      value: boolean;
    };
    [key: string]: { value: boolean | number | string } | undefined;
  };
  makeCapabilityInstance(
    capabilityId: string,
    listener: (value: number | boolean | string) => void,
  ): void;
  setCapabilityValue(opts: { capabilityId: string; value: number | boolean | string }): Promise<void>;
};

type HomeyGroup = {
  id: string;
  name: string;
};

type HomeyAPIWithManagers = {
  devices: {
    getDevices(): Promise<Record<string, HomeyDevice>>;
  };
  groups: {
    getGroups(): Promise<Record<string, HomeyGroup>>;
  };
};

class MyApp extends Homey.App {
  private deviceListeners: Map<string, () => void> = new Map();
  private timeouts: Set<NodeJS.Timeout> = new Set();
  private api?: HomeyAPIWithManagers;
  private groups: Record<string, HomeyGroup> = {}; // Cache group names

  // Anti-loop protection: Layer 1 - Debouncing per device
  private deviceStates: Map<string, { lastState: boolean; lastChangeTime: number }> = new Map();

  // Anti-loop protection: Layer 2 - Device locks (prevent A→B→A ping-pong)
  private deviceLocks: Map<string, number> = new Map(); // deviceId -> lockedUntil timestamp

  // Anti-loop protection: Layer 3 - Group-level locks
  private groupLocks: Map<string, number> = new Map(); // groupId -> lockStartTime timestamp

  // Anti-loop protection: Layer 4 - Circuit breaker
  private groupSyncCount: Map<string, { count: number; windowStart: number }> = new Map();
  private disabledGroups: Set<string> = new Set();

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    try {
      this.log('Group Device Status Sync has been initialized');
      this.log('Step 1: Starting initialization');
      // Defer API initialization to avoid blocking app startup
      this.homey.setTimeout(() => {
        this.log('Step 2: In setTimeout callback');
        this.initializeApp().catch((error) => {
          this.error('Error during app initialization:', error);
        });
      }, 2000);
      this.log('Step 3: setTimeout scheduled');
    } catch (error) {
      this.error('Error in onInit:', error);
    }
  }

  /**
   * Initialize the app after a delay
   */
  async initializeApp() {
    try {
      this.log('Step 4: initializeApp started');
      await this.homey.ready();
      this.log('Step 5: Homey ready');

      // Initialize Homey API
      this.log('Connecting to Homey API...');
      this.api = await HomeyAPIV3.createAppAPI({ homey: this.homey });
      this.log('Successfully connected to Homey API');

      // Debug: Log available API managers
      this.log('Available API managers:', Object.keys(this.api || {}).join(', '));
      if (this.api && 'groups' in this.api) {
        this.log('Groups manager is available');
      } else {
        this.log('WARNING: Groups manager is NOT available in API');
      }

      // Start monitoring devices
      await this.initializeDeviceMonitoring();
      this.log('Step 6: Device monitoring initialized');

      await this.logGroupsOverview();
      this.log('Step 7: Overview logged');
    } catch (error) {
      this.error('Error in initializeApp:', error);
      throw error;
    }
  }

  /**
   * Log overview of all groups with light devices
   */
  async logGroupsOverview() {
    try {
      this.log('═══════════════════════════════════════════════════════');
      this.log('📋 GROUPS & DEVICES OVERVIEW');
      this.log('═══════════════════════════════════════════════════════');

      const allDevices = await this.api!.devices.getDevices();

      // Group light devices by their group ID
      const devicesByGroup = new Map<string, HomeyDevice[]>();

      for (const device of Object.values(allDevices)) {
        // Only include switch devices (virtualClass='light') with onoff capability
        if (
          device.virtualClass === 'light'
          && device.capabilitiesObj
          && device.capabilitiesObj.onoff
          && device.group
        ) {
          if (!devicesByGroup.has(device.group)) {
            devicesByGroup.set(device.group, []);
          }
          devicesByGroup.get(device.group)!.push(device);
        }
      }

      if (devicesByGroup.size === 0) {
        this.log('⚠️  No groups with switch devices found');
        this.log('   Make sure you have created groups and added switch devices (virtualClass=light) to them');
        this.log('═══════════════════════════════════════════════════════');
        return;
      }

      // Get group names and cache them
      try {
        if (this.api && 'groups' in this.api && this.api.groups) {
          this.groups = await this.api.groups.getGroups();
          this.log(`Loaded ${Object.keys(this.groups).length} group names`);
        } else {
          this.log('Warning: Groups API not available, using group IDs instead of names');
        }
      } catch (error) {
        this.log('Warning: Could not fetch groups, using group IDs instead of names');
      }

      // Log each group and its devices
      let groupIndex = 1;
      for (const [groupId, devices] of devicesByGroup.entries()) {
        const groupName = this.groups[groupId]?.name || groupId;

        this.log(`\n🔌 Group ${groupIndex}: ${groupName}`);
        this.log(`   Group ID: ${groupId}`);
        this.log(`   Switch devices (${devices.length}):`);

        for (let i = 0; i < devices.length; i++) {
          const device = devices[i];
          const currentState = device.capabilitiesObj?.onoff?.value ? 'ON' : 'OFF';
          this.log(`   ${i + 1}. 🔌 ${device.name} (${currentState})`);
          this.log(`      └─ ID: ${device.id}`);
        }

        groupIndex++;
      }

      this.log('\n═══════════════════════════════════════════════════════');
      this.log(`✅ Monitoring ${devicesByGroup.size} group(s) with switch devices`);
      this.log('═══════════════════════════════════════════════════════\n');
    } catch (error) {
      this.error('Error logging groups overview:', error);
    }
  }

  /**
   * Initialize monitoring for all existing devices
   */
  async initializeDeviceMonitoring() {
    try {
      const devices = (await this.api!.devices.getDevices()) as Record<string, HomeyDevice>;
      const allDevicesCount = Object.keys(devices).length;

      let lightDevicesCount = 0;
      for (const device of Object.values(devices)) {
        const registered = await this.registerDeviceListener(device);
        if (registered) {
          lightDevicesCount++;
        }
      }

      this.log(`Found ${lightDevicesCount} switch devices to monitor (out of ${allDevicesCount} total devices)`);
    } catch (error) {
      this.error('Error initializing device monitoring:', error);
    }
  }

  /**
   * Register a listener for a specific device
   * Returns true if the device was registered, false otherwise
   */
  async registerDeviceListener(device: HomeyDevice): Promise<boolean> {
    // Only monitor switch devices with the 'onoff' capability
    if (!device.capabilitiesObj || !device.capabilitiesObj.onoff) {
      return false;
    }

    // Filter: only switches with virtualClass='light'
    if (device.virtualClass !== 'light') {
      return false;
    }

    // Must be in a group
    if (!device.group) {
      return false;
    }

    const deviceId = device.id;
    const deviceName = device.name;

    // Remove existing listener if any
    this.unregisterDeviceListener(deviceId);

    this.log(`Registering listener for switch device: ${deviceName} (group: ${device.group})`);

    // Listen for capability updates
    device.makeCapabilityInstance('onoff', async (value: boolean | number | string) => {
      this.log(`🔔 CAPABILITY CHANGE DETECTED: ${deviceName} -> ${value}`);
      if (typeof value === 'boolean') {
        await this.handleDeviceStateChange(device, value);
      }
    });

    this.deviceListeners.set(deviceId, () => {
      // Cleanup handled by Homey
    });

    return true;
  }

  /**
   * Unregister a device listener
   */
  unregisterDeviceListener(deviceId: string) {
    const removeListener = this.deviceListeners.get(deviceId);
    if (removeListener) {
      removeListener();
      this.deviceListeners.delete(deviceId);
    }
  }

  /**
   * Anti-loop Layer 1: Check if device change should be debounced
   * Returns true if the change should be ignored
   */
  private shouldDebounce(deviceId: string, newState: boolean): boolean {
    const now = Date.now();
    const deviceState = this.deviceStates.get(deviceId);

    if (deviceState) {
      const timeSinceLastChange = now - deviceState.lastChangeTime;

      // Only ignore if it's the SAME state within 500ms (duplicate event)
      // Allow state changes (ON->OFF or OFF->ON) even if rapid
      if (timeSinceLastChange < 500 && deviceState.lastState === newState) {
        return true;
      }
    }

    // Update device state
    this.deviceStates.set(deviceId, { lastState: newState, lastChangeTime: now });
    return false;
  }

  /**
   * Anti-loop Layer 2: Check if device is currently locked
   * Returns true if device is locked
   */
  private isDeviceLocked(deviceId: string): boolean {
    const lockedUntil = this.deviceLocks.get(deviceId);
    if (lockedUntil && Date.now() < lockedUntil) {
      return true;
    }
    return false;
  }

  /**
   * Anti-loop Layer 2: Lock a device for a specified duration
   */
  private lockDevice(deviceId: string, durationMs: number = 2000): void {
    const lockedUntil = Date.now() + durationMs;
    this.deviceLocks.set(deviceId, lockedUntil);
  }

  /**
   * Anti-loop Layer 3: Check if group is currently locked
   * Returns true if group is locked
   */
  private isGroupLocked(groupId: string): boolean {
    const lockStartTime = this.groupLocks.get(groupId);
    if (!lockStartTime) {
      return false;
    }

    const now = Date.now();
    const lockDuration = now - lockStartTime;

    // Force unlock if lock has been held for more than 5 seconds (safety mechanism)
    if (lockDuration > 5000) {
      this.log(`WARNING: Group ${groupId} lock held for ${lockDuration}ms, force unlocking`);
      this.groupLocks.delete(groupId);
      return false;
    }

    return true;
  }

  /**
   * Anti-loop Layer 3: Lock a group during synchronization
   */
  private lockGroup(groupId: string): void {
    this.groupLocks.set(groupId, Date.now());
  }

  /**
   * Anti-loop Layer 3: Unlock a group after synchronization
   */
  private unlockGroup(groupId: string): void {
    this.groupLocks.delete(groupId);
  }

  /**
   * Anti-loop Layer 4: Check circuit breaker - has group exceeded sync limit?
   * Returns true if group should be disabled (circuit breaker tripped)
   */
  private shouldTripCircuitBreaker(groupId: string): boolean {
    // Check if group is already disabled
    if (this.disabledGroups.has(groupId)) {
      return true;
    }

    const now = Date.now();
    const syncData = this.groupSyncCount.get(groupId);

    if (!syncData) {
      // First sync for this group
      this.groupSyncCount.set(groupId, { count: 1, windowStart: now });
      return false;
    }

    const windowDuration = now - syncData.windowStart;

    // Reset window if more than 60 seconds have passed
    if (windowDuration > 60000) {
      this.groupSyncCount.set(groupId, { count: 1, windowStart: now });
      return false;
    }

    // Increment counter
    syncData.count++;

    // Check if limit exceeded (20 syncs per minute)
    if (syncData.count > 20) {
      this.error(`🚨 EMERGENCY STOP: Group ${groupId} exceeded sync limit (${syncData.count} syncs in ${Math.round(windowDuration / 1000)}s), possible infinite loop detected!`);
      this.error(`Group ${groupId} sync DISABLED for 5 minutes`);

      // Disable group for 5 minutes
      this.disabledGroups.add(groupId);
      const timeout = this.homey.setTimeout(() => {
        this.disabledGroups.delete(groupId);
        this.groupSyncCount.delete(groupId);
        this.log(`Group ${groupId} sync re-enabled after cooldown period`);
        this.timeouts.delete(timeout);
      }, 300000); // 5 minutes
      this.timeouts.add(timeout);

      return true;
    }

    return false;
  }

  /**
   * Handle when a device state changes
   */
  async handleDeviceStateChange(device: HomeyDevice, newState: boolean) {
    const deviceId = device.id;
    const deviceName = device.name;

    // ANTI-LOOP LAYER 1: Debouncing - ignore rapid toggles
    if (this.shouldDebounce(deviceId, newState)) {
      this.log(`⏭️  Ignoring rapid toggle on device "${deviceName}" (debounced)`);
      return;
    }

    // ANTI-LOOP LAYER 2: Device lock - check if device is already locked
    if (this.isDeviceLocked(deviceId)) {
      this.log(`🔒 Device "${deviceName}" is locked, skipping sync`);
      return;
    }

    this.log(`Device "${deviceName}" changed to ${newState ? 'ON' : 'OFF'}`);

    try {
      // Get the GROUP this device belongs to
      const groupId = device.group;
      if (!groupId) {
        this.log(`Device "${deviceName}" is not in any group`);
        return;
      }

      // ANTI-LOOP LAYER 3: Group lock - check if group is already being synced
      if (this.isGroupLocked(groupId)) {
        this.log(`🔒 Group ${groupId} is locked, skipping sync`);
        return;
      }

      // ANTI-LOOP LAYER 4: Circuit breaker - check if group has exceeded sync limit
      if (this.shouldTripCircuitBreaker(groupId)) {
        this.error(`🚨 Circuit breaker ACTIVE for group ${groupId}, sync disabled`);
        return;
      }

      // Lock the group during synchronization
      this.lockGroup(groupId);

      // Get group name from cache
      const groupName = this.groups[groupId]?.name || groupId;
      this.log(`Device is in group: ${groupName}`);

      // Get all devices in the same group
      const allDevices = await this.api!.devices.getDevices();
      const devicesInSameGroup: HomeyDevice[] = [];

      for (const d of Object.values(allDevices)) {
        if (
          d.group === groupId
          && d.id !== deviceId
          && d.virtualClass === 'light'
          && d.capabilitiesObj
          && d.capabilitiesObj.onoff
        ) {
          devicesInSameGroup.push(d);
        }
      }

      if (devicesInSameGroup.length === 0) {
        this.log(`No other switch devices in group "${groupName}"`);
        this.unlockGroup(groupId);
        return;
      }

      this.log(`Syncing state to ${devicesInSameGroup.length} other switch device(s) in group "${groupName}"`);

      // Sync state to all other devices in the same group
      for (const targetDevice of devicesInSameGroup) {
        try {
          const targetId = targetDevice.id;
          const targetName = targetDevice.name;

          // Lock target device to prevent it from triggering its own sync
          this.lockDevice(targetId, 2000);

          const currentState = targetDevice.capabilitiesObj?.onoff?.value ?? false;
          if (currentState !== newState) {
            this.log(`  Syncing "${targetName}" from ${currentState ? 'ON' : 'OFF'} to ${newState ? 'ON' : 'OFF'}`);
            await targetDevice.setCapabilityValue({ capabilityId: 'onoff', value: newState });
          } else {
            this.log(`  Device "${targetName}" already in correct state`);
          }
        } catch (error) {
          const targetName = targetDevice.name;
          this.error(`Error syncing to device "${targetName}":`, error);
        }
      }
    } catch (error) {
      this.error(`Error handling device state change for "${deviceName}":`, error);
    } finally {
      // Always unlock the group when done
      const groupId = device.group;
      if (groupId) {
        this.unlockGroup(groupId);
      }
    }
  }

  /**
   * onUninit is called when the app is destroyed
   */
  async onUninit() {
    this.log('Group Device Status Sync is being unloaded');

    // Clear all timeouts
    for (const timeout of this.timeouts) {
      this.homey.clearTimeout(timeout);
    }
    this.timeouts.clear();

    // Remove all device listeners
    for (const [deviceId] of this.deviceListeners) {
      this.unregisterDeviceListener(deviceId);
    }
  }
}

export = MyApp;
