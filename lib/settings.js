const { Cc, Ci, Cu } = require("chrome");
const { Class } = require('sdk/core/heritage');
const passwords = require("sdk/passwords");
const { storage } = require("sdk/simple-storage");
const { Unknown } = require("sdk/platform/xpcom");
const self = require("sdk/self");

const { Services } = Cu.import("resource://gre/modules/Services.jsm");

/**
 * Short hand for safe Object.hasOwnProperty
 */
const has = (obj, prop) => Object.hasOwnProperty.call(obj, prop);

/**
 * Short hand for defaultdict-like behaviour
 */
const get = (obj, key, def={}) => obj[key] = has(obj, key) ? obj[key] : def;

const Setting = Class({
    initialize: function(rows, opts) {
        let doc = rows.ownerDocument;
        let elem = doc.createElement("setting");
        elem.setAttribute("title", opts.title);
        elem.setAttribute("type", opts.type);
        rows.appendChild(elem);
        this.prefPath = opts.path;
        this.elem = elem;
        let eventNames = {
            bool: ["command"],
            color: ["change"],
            integer: ["input", "change"],
            path: ["command"],
            string: ["input"],
        }[opts.type];
        for (let eventName of (eventNames || [])) {
            elem.addEventListener(eventName, this, false);
        }
        // Set the default value
        let [leaf, branch] = this._getBranch(this.prefPath);
        if (leaf in branch) {
            this.elem.value = branch[leaf];
        }
    },
    // Save the value on change
    handleEvent: function(event) {
        let [leaf, branch] = this._getBranch(this.prefPath);
        branch[leaf] = this.elem.value;
    },
    /**
     * Get the *parent* of the leaf pref with a given path; also return the leaf
     * name
     */
    _getBranch: function(path) {
        let pref = storage;
        for (let branch of path.slice(0, -1)) {
            pref = get(pref, branch, {});
        }
        return [path.slice(-1)[0], pref];
    },
});

exports.Settings = Class({
    extends: Unknown,
    interfaces: [ Ci.nsIObserver ],
    initialize: function(accounts) {
        require("sdk/system/unload").when(this.shutdown.bind(this));
        Services.obs.addObserver(this, "addon-options-displayed", false);
        Services.obs.addObserver(this, "addon-options-hidden", false);

        this.accounts = accounts;
    },
    shutdown: function(reason) {
        Services.obs.removeObserver(this, "addon-options-displayed");
        Services.obs.removeObserver(this, "addon-options-hidden");
    },
    observe: function(doc, topic, addonId) {
        let method = {
            "addon-options-displayed": this.onDisplayed,
            "addon-options-hidden": this.onHidden,
        }[topic];
        if (addonId == self.id && method) {
            try {
                method.call(this, doc.QueryInterface(Ci.nsIDOMDocument));
            } catch (e) {
                console.exception(e);
            }
        }
    },

    onDisplayed: function(doc) {
        const kPrefName = "extensions." + self.id + ".accounts.";
        let rows = doc.getElementById("detail-rows");
        for (let username of Object.keys(this.accounts).sort()) {
            let account = this.accounts[username];
            let label = doc.createElement("label");
            label.setAttribute("value", username);
            label.setAttribute("class", "detail-row");
            rows.appendChild(label);
            new Setting(rows,
                        {title: "Check on startup",
                         type: "bool",
                         path: ["accounts", username, "auto-login"]});
        }
    },
    onHidden: function(doc) {
    },
});
