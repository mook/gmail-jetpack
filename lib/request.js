/**
 * Requests that force specific sets of cookies
 * This is _not_ modeled after jetpack's sdk/requests; do not confuse the APIs.
 */
"use strict";

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
        });

        this.cookiejar = opts.cookiejar;
        this.xhr = new XMLHttpRequest({mozAnon: opts["private"], mozSystem: true});
        this.xhr.addEventListener("load", this._onload.bind(this), false);
        this.xhr.addEventListener("loadend", this._onloadend.bind(this), false);
        let url = opts.url;
        if (opts.method == "GET" && opts.data) {
            // Need to combine the query data
            let query = querystring.parse(url.search.replace(/^\?/, ""));
            for (let key of Object.keys(opts.data)) {
                query[key] = opts.data[key];
            }
            url = new URL(url.path + "?" + querystring.stringify(query), url);
        }
        this.xhr.open(opts.method, url, /*async*/ true);
        this.xhr._req.responseType = "document";
        this.channel = this.xhr._req.channel
                           .QueryInterface(Ci.nsIHttpChannelInternal)
                           .QueryInterface(Ci.nsIPrivateBrowsingChannel);
        this.channel.notificationCallbacks = new this._redirectListener(this);
    
        // Setting a load group makes impossible to go private; see bug 877961
        //if (!channel.loadGroup) {
        //    channel.loadGroup = Cc["@mozilla.org/network/load-group;1"]
        //                          .createInstance(Ci.nsILoadGroup);
        //}
    
        this.channel.setPrivate(opts["private"]);
        this.xhr._req.setRequestHeader("Cookie",
                                       this.cookiejar.get(this.channel.URI).join(";"));
        if (opts.method == "POST" && opts.data) {
            let formData = Cc["@mozilla.org/files/formdata;1"].createInstance();
            for (let key of Object.keys(opts.data)) {
                formData.append(key, opts.data[key]);
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
            this.cookiejar.add(new Cookie(cookie), this.xhr._req.channel.URI);
        }
    },

    _onload: function()  {
        try {
            this._storeCookies();
            console.log("load!", this.xhr._req.response, "::", this.cookiejar);
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

    addEventListener: function(name, listener, capture)
        this.xhr.addEventListener(name, listener, capture),

    _redirectListener: Class({
        extends: Unknown,
        initialize: function(request) this.req = request,
        interfaces: ["nsIInterfaceRequestor", "nsIRedirectResultListener"],
        getInterface: function(iid) this.QueryInterface(iid),
        onRedirectResult: function(proceeding) {
            // |this| is the Request!
            console.log("onRedirectResult", this);
            try {
                let channel = this.req.channel.QueryInterface(Ci.nsIHttpChannel);
                let cookieHeader = channel.getResponseHeader("Set-Cookie");
                if (!cookieHeader) {
                    return;
                }
                let cookies = NetworkHelper.parseSetCookieHeader(cookieHeader);
                for (let cookie of cookies) {
                    console.log("cookie:", JSON.stringify(cookie));
                    this.req.cookiejar.add(new Cookie(cookie), channel.URI);
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
    let req = new Request(options);
    let succeeded = false;
    req.addEventListener("load", function(event) {
        deferred.resolve(req.xhr._req.response);
    }, false);
    req.addEventListener("loadend", function(event) {
        deferred.reject(event); // does nothing if already resolved
    }, false);
    return deferred.promise;
};
