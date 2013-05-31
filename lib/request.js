/**
 * Requests that force specific sets of cookies
 * This is _not_ modeled after jetpack's sdk/requests; do not confuse the APIs.
 */
"use strict";

const { Class } = require('sdk/core/heritage');
const { Unknown } = require('sdk/platform/xpcom');
const { Cc, Ci, Cr, Cu } = require("chrome");
const { XMLHttpRequest } = require("sdk/net/xhr");

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "NetworkHelper",
                                  "resource://gre/modules/devtools/NetworkHelper.jsm");

/**
 * Create a cookie object
 * Input is a dict, should have the same things as cookie properties:
 * name {String} The name of the cookie
 * value {String} The value of the cookie
 * secure {Boolean}
 * httpOnly {Boolean}
 * path {String} (optional)
 * domain {String} (optional)
 * expires {String} (optional) -> This gets converted to a number as in Date.valueOf()
 */
function Cookie(data) {
    for (let key of Object.keys(data)) {
        this[key] = data[key];
    }
    if ("expires" in data) {
        this.expires = Date.parse(data.expires);
    }
}
Cookie.prototype.toString = () => this.value;
/**
 * Check if this cookie should apply to the given URL
 * @param url {sdk/url::URL} The URL to check
 * @returns {Boolean}
 */
Cookie.prototype.appliesTo = function(url) {
    if (this.expired) {
        return false;
    }
    
};
Object.defineProperty(Cookie.prototype, "expired", {
    get: () => this.expires ? Date.now() < this.expires : false,
    enumerable: true});

/**
 * Create a request; all options other than url are optional.
 * @param url {String} The URL to open
 * @param private {Boolean} Is this request private? Defaults to true.
 * @param cookies {Object} Key/value hash of cookies to set
 * @param method {String} One of GET or POST; default is GET.
 */
function Request(options) {
    console.log("making new request:", options);

    this.cookies = {};
    for (let key of Object.keys(options.cookies || {})) {
        this.cookies[key] = new Cookie(options.cookies[key]);
    }

    let isPrivate = "private" in options ? !!options.private : true;
    let method = "method" in options ? options.method : "GET";

    this.xhr = new XMLHttpRequest({mozAnon: isPrivate, mozSystem: true});
    this.xhr.addEventListener("load", this.onload.bind(this), false);
    this.xhr.open(method.toUpperCase(), options.url, /*async*/ true);
    this.xhr._req.responseType = "document";
    let channel = this.xhr._req.channel
                      .QueryInterface(Ci.nsIHttpChannelInternal)
                      .QueryInterface(Ci.nsIPrivateBrowsingChannel);
    

    // Setting a load group makes impossible to go private; see bug 877961
    //if (!channel.loadGroup) {
    //    channel.loadGroup = Cc["@mozilla.org/network/load-group;1"]
    //                          .createInstance(Ci.nsILoadGroup);
    //}

    channel.setPrivate(isPrivate);
    console.log("about to send request");
    this.xhr.send();
}

Request.prototype._loadCookies = function() {
    let cookieHeader= this.xhr.getResponseHeader("Set-Cookie");
    if (!cookieHeader) {
        return;
    }
    let cookies = NetworkHelper.parseSetCookieHeader(cookieHeader);
    for (let cookie of cookies) {
        cookie = new Cookie(cookie);
        if (cookie.expired) {
            delete this.cookies[cookie.name];
        } else {
            this.cookies[cookie.name] = cookie;
        }
    }
};

Request.prototype.onload = function()  {
    try {
        this._loadCookies();
        console.log("load!", JSON.stringify(this.cookies), "::", this.xhr._req.response);
    } catch(e) {
        console.error(e);
    }
};

exports.Request = Request;
