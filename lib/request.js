/**
 * Requests that force specific sets of cookies
 * This is _not_ modeled after jetpack's sdk/requests; do not confuse the APIs.
 */
"use strict";

/**
 * Short hand for safe Object.hasOwnProperty
 */
const has = (obj, prop) => Object.hasOwnProperty.call(obj, prop);

/**
 * Short hand for defaultdict-like behaviour
 */
const get = (obj, key, def={}) => obj[key] = has(obj, key) ? obj[key] : def;

const { Class } = require('sdk/core/heritage');
const { Unknown } = require('sdk/platform/xpcom');
const { Cc, Ci, Cr, Cu } = require("chrome");
const { XMLHttpRequest } = require("sdk/net/xhr");
const { defer } = require("sdk/core/promise");
const { validateOptions } = require("sdk/deprecated/api-utils");
const { URL } = require("sdk/url");
const querystring = require("sdk/querystring");

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "NetworkHelper",
                                  "resource://gre/modules/devtools/NetworkHelper.jsm");

const { CookieJar, Cookie } = require("./cookiejar");

/**
 * Create a request; all options other than url are optional.
 * @param url {String} The URL to open
 * @param private {Boolean} Is this request private? Defaults to true.
 * @param cookiejar {./cookiejar::CookieJar} The cookie jar to use
 * @param method {String} One of GET or POST; default is GET.
 * @param data {Hash} Post data / query string (as a key/value hash)
 */
const Request = exports.Request = Class({
    initialize: function (opts) {
        console.log("making new request:", JSON.stringify(opts));
        opts = validateOptions(opts, {
            url: {
                map: (v) => new URL(v && v instanceof Ci.nsIURI ? v.spec : v),
                ok: (v) => v instanceof URL,
            },
            "private": {
                map: (v) => v === undefined ? true : !!v,
                is: ["boolean"],
            },
            cookiejar: {
                map: (v) => v || new CookieJar(),
                ok: (v) => v instanceof CookieJar,
            },
            method: {
                map: (v) => String(v).toUpperCase().valueOf(),
                ok: (v) => ["GET", "POST"].indexOf(v) >= 0,
            },
            data: {
                is: ["object", "undefined"],
            },
            referrer: {
                is: ["undefined", "string"],
            }
        });

        this.opts = opts;
        this.listeners = {};
        this.handleEvent = this.handleEvent.bind(this);
        this._send(this.opts.url);
    },

    _send: function(url) {
        this.xhr = new XMLHttpRequest({mozAnon: this.opts["private"], mozSystem: true});
        this.xhr.addEventListener("load", this._onload.bind(this), false);
        this.xhr.addEventListener("loadend", this._onloadend.bind(this), false);
        for (let eventType of Object.keys(this.listeners)) {
            this.xhr.addEventListener(eventType, this.handleEvent, false);
        }
        if (this.opts.method == "GET" && this.opts.data) {
            // Need to combine the query data
            let query = querystring.parse(url.search.replace(/^\?/, ""));
            for (let key of Object.keys(this.opts.data)) {
                query[key] = this.opts.data[key];
            }
            url = new URL(url.path + "?" + querystring.stringify(query), url);
        }
        this.xhr.open(this.opts.method, url, /*async*/ true);
        this.xhr._req.responseType = "document";
        this.channel = this.xhr._req.channel
                           .QueryInterface(Ci.nsIHttpChannelInternal)
                           .QueryInterface(Ci.nsIPrivateBrowsingChannel);
        this.channel.notificationCallbacks = new this._redirectListener(this, this.channel);
    
        // Setting a load group makes impossible to go private; see bug 877961
        //if (!channel.loadGroup) {
        //    channel.loadGroup = Cc["@mozilla.org/network/load-group;1"]
        //                          .createInstance(Ci.nsILoadGroup);
        //}
    
        this.channel.setPrivate(this.opts["private"]);
        let cookies = this.opts.cookiejar.get(this.channel.URI);
        this.xhr._req.setRequestHeader("Cookie",
                                       [c.requestString for (c of cookies)].join(";"));
        if (this.opts.referrer) {
            this.xhr._req.setRequestHeader("Referer", // Spelling mistake per spec
                                           this.opts.referrer);
        }
        if (this.opts.method == "POST" && this.opts.data) {
            let formData = Cc["@mozilla.org/files/formdata;1"].createInstance();
            for (let key of Object.keys(this.opts.data)) {
                formData.append(key, this.opts.data[key]);
            }
            this.xhr.send(formData);
        } else {
            this.xhr.send();
        }
    },

    _storeCookies: function() {
        let cookieHeader = this.xhr.getResponseHeader("Set-Cookie");
        if (!cookieHeader) {
            return;
        }
        console.log("raw cookies:", cookieHeader);
        let cookies = NetworkHelper.parseSetCookieHeader(cookieHeader);
        for (let cookie of cookies) {
            console.log("cookie:", JSON.stringify(cookie));
            this.opts.cookiejar.add(new Cookie(cookie),
                                    this.xhr._req.channel.URI);
        }
    },

    _onload: function()  {
        try {
            this._storeCookies();
            console.log("load!", this.xhr._req.channel.URI.spec, "->",
                        this.xhr._req.response, "::", this.opts.cookiejar);
        } catch(e) {
            console.exception(e);
        }
    },

    _onloadend: function(channel) {
        if (this.channel) {
            this.channel.notificationCallbacks = null;
            this.channel = null;
        }
    },

    addEventListener: function(name, listener, capture) {
        if (capture) {
            throw "Capture not yet supported";
        }
        if (!has(this.listeners, name)) {
            this.xhr.addEventListener(name, this.handleEvent, false);
        }
        get(this.listeners, name, []).push(listener);
    },

    removeEventListener: function(name, listener) {
        let queue = this.listeners[name];
        if (!queue) {
            return; // no listeners for this event? probably removed...
        }
        let i = queue.indexOf(listener);
        if (i >= 0) {
            queue.splice(i, 1);
        }
    },

    handleEvent: function(event) {
        let queue = this.listeners[event.type];
        if (!queue) {
            return; // no listeners for this event? probably removed...
        }
        for (let listener of queue) {
            try {
                listener.call(this, event);
            } catch(e) {
                console.exception(e);
            }
        }
    },

    _redirectListener: Class({
        extends: Unknown,
        initialize: function(request, channel) {
            this.req = request;
            this.chan = channel;
        },
        interfaces: ["nsIInterfaceRequestor", "nsIRedirectResultListener"],
        getInterface: function(iid) this.QueryInterface(iid),
        onRedirectResult: function(proceeding) {
            console.log("onRedirectResult");
            let hasCookies = false;
            try {
                let xhr = this.req.xhr;
                let oldChannel = this.chan.QueryInterface(Ci.nsIHttpChannel);
                let newChannel = xhr._req.channel.QueryInterface(Ci.nsIHttpChannel);
                this.chan = newChannel; // for next time
                let cookieHeader = "";
                console.log("---- initial channel", oldChannel.URI.spec, "----");
                try {
                    oldChannel.visitResponseHeaders((k, v) => console.log(k, ":", v));
                } catch(e) {
                    console.log("error:", e);
                }
                console.log("---- current channel", newChannel.URI.spec, "----");
                try {
                    newChannel.visitResponseHeaders((k, v) => console.log(k, ":", v));
                } catch(e) {
                    console.log("error:", e);
                }
                try {
                    cookieHeader = oldChannel.getResponseHeader("Set-Cookie");
                } catch (e) {
                    // No cookies
                    console.log("redirected from", oldChannel.URI.spec, "to",
                                newChannel.URI.spec, "with no additional cookies");
                    return;
                }
                if (cookieHeader) {
                    let cookies = NetworkHelper.parseSetCookieHeader(cookieHeader);
                    for (let cookie of cookies) {
                        console.log("cookie:", JSON.stringify(cookie));
                        this.req.opts.cookiejar.add(new Cookie(cookie), oldChannel.URI);
                        hasCookies = true;
                    }
                }
                if (hasCookies) {
                    // Need to restart the channel so we can inject new cookies... joy.
                    // remove event listeners
                    for (let eventType of Object.keys(this.req.listeners)) {
                        xhr.removeEventListener(eventType, this.req.handleEvent);
                    }
                    xhr.abort();
                    // Make a new request with new cookies
                    let url = new URL(newChannel.URI.spec);
                    
                    console.log("redirecting from", oldChannel.URI.spec, "to", url);
                    this.req.opts.referrer = oldChannel.URI.spec;
                    this.req._send(url);
                } else {
                    console.log("redirected from", oldChannel.URI.spec, "to",
                                newChannel.URI.spec,
                                "but with no cookies even with Set-Cookie set");
                }
            } catch(e) {
                console.exception(e);
            }
        },
    }),
});

/**
 * Promise-style request; takes the same arguments as a Request
 */
const RequestPromise = exports.RequestPromise = function(options) {
    let deferred = defer();
    try {
        let req = new Request(options);
        let succeeded = false;
        console.log("Requesting", options.url);
        req.addEventListener("load", function(event) {
            console.error("Load success");
            deferred.resolve(req.xhr._req.response);
        }, false);
        req.addEventListener("loadend", function(event) {
            console.error("Load end");
            deferred.reject(event); // does nothing if already resolved
        }, false);
    } catch (e) {
        deferred.reject(e);
    }
    return deferred.promise;
};
