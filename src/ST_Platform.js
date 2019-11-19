const {
    knownCapabilities,
    pluginName,
    platformName,
    platformDesc,
    pluginVersion
} = require("./Constants"),
    myUtils = require("./MyUtils"),
    SmartThingsClient = require("./ST_Client"),
    SmartThingsAccessories = require("./ST_Accessories"),
    express = require("express"),
    bodyParser = require("body-parser"),
    logger = require("./Logger.js").Logger,
    webApp = express();

var PlatformAccessory;

module.exports = class ST_Platform {
    constructor(log, config, api) {
        this.config = config;
        this.homebridge = api;
        this.log = logger.withPrefix(`${this.config["name"]} (${pluginVersion})`);
        this.log(`Homebridge Version: ${api.version}`);
        this.log(`${platformName} Plugin Version: ${pluginVersion}`);
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        PlatformAccessory = api.platformAccessory;
        this.uuid = api.hap.uuid;
        if (config === undefined || config === null || config.app_url === undefined || config.app_url === null || config.app_id === undefined || config.app_id === null) {
            this.log.warn(`${platformName} Plugin is not Configured | Skipping...`);
            return;
        }
        this.polling_seconds = config["polling_seconds"] || 3600;
        this.excludedAttributes = this.config["excluded_attributes"] || [];
        this.excludedCapabilities = this.config["excluded_capabilities"] || [];
        this.update_method = this.config["update_method"] || "direct";
        this.temperature_unit = "F";
        this.local_commands = false;
        this.local_hub_ip = undefined;
        this.myUtils = new myUtils(this);
        this.configItems = this.getConfigItems();
        this.myUtils.checkVersion();
        this.deviceCache = {};
        this.attributeLookup = {};
        this.knownCapabilities = knownCapabilities;
        this.unknownCapabilities = [];
        this.client = new SmartThingsClient(this);

        this.SmartThingsAccessories = new SmartThingsAccessories(this);

        this.homebridge.on("didFinishLaunching", this.didFinishLaunching.bind(this));
    }

    getConfigItems() {
        return {
            app_url: this.config["app_url"],
            app_id: this.config["app_id"],
            access_token: this.config["access_token"],
            update_seconds: this.config["update_seconds"] || 30,
            direct_port: this.config["direct_port"] || 8000,
            direct_ip: this.config["direct_ip"] || this.myUtils.getIPAddress()
        };
    }

    getDeviceCache() {
        return this.deviceCache || {};
    }
    getDeviceCacheItem(devid) {
        return this.deviceCache[devid] || undefined;
    }

    updDeviceCacheItem(devid, data) {
        this.deviceCache[devid] = data;
    }

    remDeviceCacheItem(devid) {
        delete this.deviceCache[devid];
    }

    didFinishLaunching() {
        this.log(`Fetching ${platformName} Devices. NOTICE: This may take a moment if you have a large number of device data is being loaded!`);
        setInterval(this.refreshDevices.bind(this), this.polling_seconds * 1000);
        let that = this;
        this.refreshDevices()
            .then(() => {
                that.WebServerInit(that)
                    .catch(err => that.log.error("WebServerInit Error: ", err))
                    .then(resp => {
                        if (resp && resp.status === "OK") that.client.sendStartDirect();
                    });
            })
            .catch(err => {
                that.log.error(err);
            });
    }

    refreshDevices() {
        let that = this;
        let starttime = new Date();
        return new Promise(resolve => {
            try {
                that.log.debug("Refreshing All Device Data");
                this.client
                    .getDevices()
                    .then(resp => {
                        // console.log(resp);
                        if (resp && resp.deviceList && resp.deviceList instanceof Array) {
                            // that.log.debug("Received All Device Data");
                            const toCreate = this.SmartThingsAccessories.diffAdd(resp.deviceList);
                            const toUpdate = this.SmartThingsAccessories.intersection(resp.deviceList);
                            const toRemove = this.SmartThingsAccessories.diffRemove(resp.deviceList);
                            that.log.warn(`Devices to Remove: (${Object.keys(toRemove).length})`, toRemove.map(i => i.name));
                            that.log.info(`Devices to Update: (${Object.keys(toUpdate).length})`);
                            that.log.good(`Devices to Create: (${Object.keys(toCreate).length})`, toCreate.map(i => i.name));

                            toRemove.forEach(accessory => this.removeAccessory(accessory));
                            toUpdate.forEach(device => this.updateDevice(device));
                            toCreate.forEach(device => this.addDevice(device));
                        }
                        if (resp && resp.location) {
                            that.temperature_unit = resp.location.temperature_scale;
                            if (resp.location.hubIP) {
                                that.local_hub_ip = resp.location.hubIP;
                                that.local_commands = resp.location.local_commands === true;
                                that.client.updateGlobals(that.local_hub_ip, that.local_commands);
                            }
                        }
                        that.log.alert(`Total Initialization Time: (${Math.round((new Date() - starttime) / 1000)} seconds)`);
                        that.log.notice(`Unknown Capabilities: ${JSON.stringify(that.unknownCapabilities)}`);
                        that.log.info(`${platformDesc} DeviceCache Size: (${Object.keys(this.SmartThingsAccessories.getAll()).length})`);
                        resolve(true);
                    })
                    .catch(err => {
                        that.log.error(err);
                        resolve(false);
                    });
            } catch (e) {
                this.log.error("Failed to refresh devices.", e);
                resolve(false);
            }
        });
    }

    getNewAccessory(device, UUID) {
        let accessory = new PlatformAccessory(device.name, UUID);
        this.SmartThingsAccessories.PopulateAccessory(accessory, device);
        return accessory;
    }

    addDevice(device) {
        let accessory;
        const new_uuid = this.uuid.generate(`smartthings_v2_${device.deviceid}`);
        device.excludedCapabilities = this.excludedCapabilities[device.deviceid] || ["None"];
        this.log.debug(`Initializing New Device (${device.name} | ${device.deviceid})`);
        accessory = this.getNewAccessory(device, new_uuid);
        accessory.reachable = true;
        this.homebridge.registerPlatformAccessories(pluginName, platformName, [accessory]);
        this.SmartThingsAccessories.add(accessory);
        this.log(`Added Device: (${accessory.name} | ${accessory.deviceid})`);
    }

    updateDevice(device) {
        let cacheDevice = this.SmartThingsAccessories.get(device);
        let accessory;
        device.excludedCapabilities = this.excludedCapabilities[device.deviceid] || ["None"];
        this.log(`Loading Existing Device (${device.name}) | (${device.deviceid})`);
        accessory = this.SmartThingsAccessories.loadAccesoryData(cacheDevice, device);
        accessory.reachable = true;
        this.SmartThingsAccessories.add(accessory);
    }

    ignoreDevice(data) {
        const [device, reason] = data;
        if (!this.SmartThingsAccessories.ignore(device)) {
            return;
        }
        this.log(`${reason}: ${device.name} (${device.deviceid})`);
    }

    removeAccessory(accessory) {
        this.log(accessory);
        if (this.SmartThingsAccessories.remove(accessory)) {
            this.homebridge.unregisterPlatformAccessories(pluginName, platformName, [accessory]);
            this.log(`Removed: ${accessory.context.name} (${accessory.context.deviceid})`);
        }
    }

    configureAccessory(accessory) {
        this.log(`Configure Cached Accessory: ${accessory.displayName}, UUID: ${accessory.UUID}`);
        let cachedAccessory = this.SmartThingsAccessories.CreateFromCachedAccessory(accessory, this);
        this.SmartThingsAccessories.add(cachedAccessory);
    }

    processIncrementalUpdate(data, that) {
        that.log.debug("new data: " + data);
        if (data && data.attributes && data.attributes instanceof Array) {
            for (let i = 0; i < data.attributes.length; i++) {
                that.processDeviceAttributeUpdate(data.attributes[i], that);
            }
        }
    }

    processDeviceAttributeUpdate(change) {
        let attrObj = this.SmartThingsAccessories.getAttributeStoreItem(change.attribute, change.deviceid);
        let accessory = this.SmartThingsAccessories.get(change);
        if (!attrObj || !accessory) return;
        if (attrObj instanceof Array) {
            attrObj.forEach(item => {
                accessory.context.deviceData.attributes[change.attribute] = change.value;
                item.getValue();
            });
        }
    }

    isValidRequestor(access_token, app_id, src) {
        if (app_id && access_token && (access_token === this.getConfigItems().access_token) && (app_id === this.getConfigItems().app_id)) return true;
        this.log.error(`(${src}) | We received a request from a client that didn't provide a valid access_token and app_id`);
        return false;
    }

    WebServerInit() {
        let that = this;
        // Get the IP address that we will send to the SmartApp. This can be overridden in the config file.
        return new Promise(resolve => {
            try {
                let ip = that.configItems.direct_ip || that.myUtils.getIPAddress();
                that.log("WebServer Initiated...");

                // Start the HTTP Server
                webApp.listen(that.configItems.direct_port, () => {
                    that.log(`Direct Connect is Listening On ${ip}:${that.configItems.direct_port}`);
                });

                webApp.use(bodyParser.urlencoded({
                    extended: false
                }));
                webApp.use(bodyParser.json());
                webApp.use((req, res, next) => {
                    res.header("Access-Control-Allow-Origin", "*");
                    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
                    next();
                });

                webApp.get("/", (req, res) => {
                    res.send("WebApp is running...");
                });

                webApp.post("/initial", (req, res) => {
                    let body = JSON.parse(JSON.stringify(req.body));
                    if (body && that.isValidRequestor(body.access_token, body.app_id, 'initial')) {
                        that.log(`${platformName} Hub Communication Established`);
                        res.send({
                            status: "OK"
                        });
                    } else {
                        res.send({
                            status: "Failed: Missing access_token or app_id"
                        });
                    }
                });

                webApp.post("/restartService", (req, res) => {
                    let body = JSON.parse(JSON.stringify(req.body));
                    if (body && that.isValidRequestor(body.access_token, body.app_id, 'restartService')) {
                        let delay = 10 * 1000;
                        that.log(`Received request from ${platformName} to restart homebridge service in (${(delay / 1000)} seconds) | NOTICE: If you using PM2 or Systemd the Homebridge Service should start back up`);
                        setTimeout(() => {
                            process.exit(1);
                        }, parseInt(delay));
                        res.send({
                            status: "OK"
                        });
                    } else {
                        res.send({
                            status: "Failed: Missing access_token or app_id"
                        });
                    }
                });

                webApp.post("/refreshDevices", (req, res) => {
                    let body = JSON.parse(JSON.stringify(req.body));
                    if (body && that.isValidRequestor(body.access_token, body.app_id, 'refreshDevices')) {
                        that.log(`Received request from ${platformName} to refresh devices`);
                        that.refreshDevices();
                        res.send({
                            status: "OK"
                        });
                    } else {
                        that.log.error(`Unable to start device refresh because we didn't receive a valid access_token and app_id`);
                        res.send({
                            status: "Failed: Missing access_token or app_id"
                        });
                    }
                });

                webApp.post("/updateprefs", (req, res) => {
                    let body = JSON.parse(JSON.stringify(req.body));
                    if (body && that.isValidRequestor(body.access_token, body.app_id, 'updateprefs')) {
                        that.log(platformName + " Hub Sent Preference Updates");
                        let sendUpd = false;
                        if (body.local_commands && that.local_commands !== body.local_commands) {
                            sendUpd = true;
                            that.log(`${platformName} Updated Local Commands Preference | Before: ${that.local_commands} | Now: ${body.local_commands}`);
                            that.local_commands = body.local_commands;
                        }
                        if (body.local_hub_ip && that.local_hub_ip !== body.local_hub_ip) {
                            sendUpd = true;
                            that.log(`${platformName} Updated Hub IP Preference | Before: ${that.local_hub_ip} | Now: ${body.local_hub_ip}`);
                            that.local_hub_ip = body.local_hub_ip;
                        }
                        if (sendUpd) {
                            that.client.updateGlobals(that.local_hub_ip, that.local_commands);
                        }
                        res.send({
                            status: "OK"
                        });
                    } else {
                        res.send({
                            status: "Failed: Missing access_token or app_id"
                        });
                    }
                });

                webApp.post("/update", (req, res) => {
                    if (req.body.length < 3) return;
                    let body = JSON.parse(JSON.stringify(req.body));
                    if (body && that.isValidRequestor(body.access_token, body.app_id, 'update')) {
                        if (Object.keys(body).length > 3) {
                            let newChange = {
                                deviceid: body.change_device,
                                attribute: body.change_attribute,
                                value: body.change_value,
                                date: body.change_date
                            };
                            that.log.notice(`Change Event: (${body.change_name}) [${(body.change_attribute ? body.change_attribute.toUpperCase() : "unknown")}] is ${body.change_value}`);
                            that.processDeviceAttributeUpdate(newChange);
                        }
                        res.send({
                            status: "OK"
                        });
                    } else {
                        res.send({
                            status: "Failed: Missing access_token or app_id"
                        });
                    }
                });
                resolve({
                    status: "OK"
                });
            } catch (ex) {
                that.log.error('WebServerInit Exception: ', ex.message);
                resolve({
                    status: ex.message
                });
            }
        });
    }
};