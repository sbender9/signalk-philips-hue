/*
 * Copyright 2016 Scott Bender <scott@scottbender.net>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const fs = require('fs')
const _ = require('lodash')
const request = require("request")
const camelCase = require('camelcase')

const base = 'electrical.switches.hue'
const colorModeMap = {
  hs: 'hsb',
  ct: 'temperature',
  xy: 'cie'
}

module.exports = function(app) {
  var plugin = {}
  var statusMessage = "Not Started"
  var registeredForPut
  var onStop = []
  
  plugin.start = function(props) {
    registeredForPut = {
      'groups': {},
      'lights': {}
    }
    statusMessage = 'Starting...'
    if ( _.isUndefined(props.address) ) {
      request({
        url: 'https://discovery.meethue.com/',
        method: "GET",
        json: true,
      }, (error, response, body) => {
        if (!error && response.statusCode === 200) {
          app.debug('body: %j', body)
          if ( _.isArray(body) && body.length > 0 ) {
            let ip = body[0].internalipaddress
            app.debug(`found bridge at ${ip}`)
            loadBridge(props, ip)
          } else {
            statusMessage = 'No bridges found'
            app.error(statusMessage)
          }
        } else {
          printRequestError(error, response)
        }
      })
    } else {
      app.debug(`using configured ip address ${props.address}`)
      loadBridge(props, props.address)
    }
  };

  plugin.statusMessage = () => {
    return statusMessage
  }

  plugin.stop = function() {
    onStop.forEach(f => f())
  }

  function printRequestError(error, response) {
    statusMessage = '' + error
    app.error("error: " + error)
    //app.error("response.statusCode: " + response.statusCode)
    //app.error("response.statusText: " + response.statusText)
  }

  function loadBridge(props, ip) {
    statusMessage = `Connecting to ${ip}`
    if ( _.isUndefined(props.username) ) {
      request({
        url: `http://${ip}/api`,
        method: 'POST',
        json: true,
        headers: {
          "content-type": "application/json",
        },
        body: {
          devicetype: 'signalk-philips-hue#signalk-node-server'
        }
      }, (error, response, body) => {
        if (!error && response.statusCode === 200) {
          app.debug('user body: %j', body)

          if ( _.isArray(body) && body.length > 0 && _.isObject(body[0]) && (body[0].error || body[0].success) ) {
            let res = body[0]
            if ( res.success ) {
              statusMessage = 'Obtained username'
              props.username = res.success.username
              app.savePluginOptions(props, () => {})
              startLoading(props, ip)
            } else {
              statusMessage = res.error.description
              app.error(statusMessage)
            }
          } else {
            statusMessage = `Invalid Discovery Response  ${JSON.stringify(body)}`
            app.error(statusMessage)
          }
        } else {
          printRequestError(error, response)
        }
      })
    } else {
      startLoading(props, ip)
    }
  }

  function startLoading(props, ip) {
    load(props, ip)
    let timer = setInterval(() => {
      load(props, ip)
    }, (props.refreshRate || 5)  * 1000)
    onStop.push(() => clearInterval(timer))
  }

  function getActionHandler(data) {
    return (context, path, value, cb) => {
      return actionHandler(context, path, value, data, cb)
    }
  }

  function actionHandler(context, path, value, data, cb) {
    let new_value = value
    let type = data.type
    if ( data.type === 'dimmingLevel' ) {
      new_value = Math.round(value * 254)
      type = 'bri'
    } else {
      type = 'on'
      new_value = new_value ? true : false
    }

    let action = data.hueType === 'groups' ? 'action' : 'state'
    let requestPath = `/${data.hueType}/${data.id}/${action}`
    let url = `http://${data.ip}/api/${data.props.username}${requestPath}`
    let body = {
      [type]: new_value
    }
    app.debug(`Sending PUT: ${url}: ${JSON.stringify(body)}`)
    request({
        url: url,
        method: 'PUT',
        json: true,
        headers: {
          "content-type": "application/json",
        },
        body: body
      }, (error, response, body) => {
        if (!error && response.statusCode === 200) {
          app.debug('action body: %j', body)

          if ( _.isArray(body) && body.length > 0 && _.isObject(body[0]) && (body[0].error || body[0].success) ) {
            if ( body[0].success ) {
              let result_value = body[0].success[`${requestPath}/${type}`]
              if ( data.type === 'dimmingLevel' ) {
                result_value = result_value / 254.0
              }
              
              app.handleMessage(plugin.id, {
                updates: [{
                  values: [{
                    path: path,
                    value: result_value
                  }]
                }]
              })
              cb({state: 'SUCCESS'})
            } else {
              cb({
                state: 'FAILURE',
                message: body[0].error.description
              })
            }
          } else {
            let msg = `Invalid Response ${JSON.stringify(body)}`
            app.error(msg)
            cb({
              state: 'FAILURE',
              message: msg
            })
          }
        } else {
          printRequestError(error, response)
          cb({
            state: 'FAILURE',
            message: '' + error
          })
        }
      })
    return { state: 'PENDING' }
  }

  function load(props, ip) {
    loadInfo(props, ip, 'lights')
    loadInfo(props, ip, 'groups')
  }

  function loadInfo(props, ip, hueType) {
    request({
        url: `http://${ip}/api/${props.username}/${hueType}`,
        method: 'GET',
        json: true,
      }, (error, response, body) => {
        if (!error && response.statusCode === 200) {
          statusMessage = `Connected to ${ip}`
          app.debug('%s body: %j', hueType, body)

          _.keys(body).forEach(key => {
            let light = body[key]
            let displayName = light.name
            let path = `${base}.${hueType}.${camelCase(displayName)}`
            let state
            let on
            
            if ( hueType === 'groups' ) {
              state = light.action
              on = light.state.any_on
            } else {
              state = light.state
              on = light.state.on
            }

            var values = [
              {
                path: `${path}.state`,
                value: on
              },
              {
                path: `${path}.dimmingLevel`,
                value: state.bri / 255.0
              },
              {
                path: `${path}.meta`,
                value: {
                  type: 'dimmer',
                  displayName: displayName,
                  hueModel: light.modelid
                }
              }
            ]

            if ( state.colormode ) {
              values.push({
                path: `${path}.colorMode`,
                value: colorModeMap[state.colormode]
              })

              if ( state.hue && state.sat ) {
                values.push({
                  path: `${path}.hue`,
                  value: state.hue / 182.04 / 360.0
                })
                values.push({
                  path: `${path}.saturation`,
                  value: state.sat / 255.0
                })
              }

              if ( state.ct ) {
                values.push({
                  path: `${path}.temperature`,
                  value: 1000000.0/state.ct
                })
              }

              if ( state.xy ) {
                values.push({
                  path: `${path}.cie`,
                  value: { x: state.xy[0], y: state.xy[1] }
                })
              }
            }

            if ( !registeredForPut[hueType][key] && app.registerActionHandler ) {
              app.registerActionHandler('vessels.self',
                                        `${path}.state`,
                                        getActionHandler({
                                          ip: ip,
                                          props: props,
                                          id: key,
                                          type: 'state',
                                          hueType: hueType
                                        }))
              app.registerActionHandler('vessels.self',
                                        `${path}.dimmingLevel`,
                                        getActionHandler({
                                          ip: ip,
                                          props: props,
                                          id: key,
                                          type: 'dimmingLevel',
                                          hueType: hueType
                                        }))
              
              registeredForPut[hueType][key] = true
            }
            
            app.handleMessage(plugin.id, {
              updates: [
                {
                  values: values
                }
              ]
            })
          })
        } else {
          printRequestError(error, response)
        }
      })
  }



  /*
  function send_to_iftt(eventName, state, message, path)
  {
    var url = "https://maker.ifttt.com/trigger/" + eventName + "/with/key/" + privateKey
    app.debug("url: " + url)
    json = { "message": message, "state": state, "path": path }

    app.debug("json: " + JSON.stringify(json))
    request({
      url: url,
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      json: true,
      body: json,
    }, function(error, response, body)
            {
              if (!error && response.statusCode === 200) {
                debug(body)
              }
              else {
                console.log("error: " + error)
                console.log("response.statusCode: " + response.statusCode)
                console.log("response.statusText: " + response.statusText)
              }
            }
           )
  }
  */
  
  plugin.id = "signalk-philips-hue"
  plugin.name = "Philips Hue"
  plugin.description = "Signal K Node Server Plugin To Operate Hue Lights"

  plugin.schema = {
    title: plugin.name,
    description: "Please press the link button on your Hue Hub before enabling this plugin",
    properties: {
      address: {
        type: 'string',
        title: 'IP Address',
        description: 'If blank, https://discovery.meethue.com will be used to auto discover, internet connection required'
      },
      refreshRate: {
        type: 'number',
        title: 'Refresh Rate',
        description: 'The rate in witch the hub will be queried for updates in seconds',
        default: 5
      }
    }
    
  }
  return plugin;
}

