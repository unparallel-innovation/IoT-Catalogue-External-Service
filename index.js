
const EventEmmiter = require("events")
const ws = require("ws");
const SimpleDDP = require("simpleddp");
const crypto = require("crypto");
const axios = require('axios').default;

const simpleDDPLogin = require("simpleddp-plugin-login").simpleDDPLogin;

/**
 * Establishes a connection with IoT Catalogue, allows subscription with a queue and to the dataset authenticated for the user
 * @extends EventEmmiter
 */
class Connection extends EventEmmiter{

    /**
     * Props related with data subscription
     * @typedef {Object} connectionProps
     * @property {object} dataFields - Fields that must be returned from the data subscription
     */


    /**
     *
     * @param {String} socketAddress  Web socket address to IoT Catalogue instance
     * @param {String} token Token used to authenticate the user
     * @param {Object} serviceDescription Object describing the features of the external service
     * @param {connectionProps} connectionProps Props related with data subscription
     */
    constructor(socketAddress, token,  serviceDescription, connectionProps) {
        super();
        this.socketAddress = socketAddress
        this.socketAddressURL = new URL(this.socketAddress)
        this.token = token
        this.serviceDescription = serviceDescription
        this.connectionProps = connectionProps
        this.collectionHandlers = []
        this.collectionSubscription = []
        this.pingInterval = 60
        this.timeout = 60
        if(! this.socketAddress){
            throw {"err":"Missing socketAddress"}
        }

        if(!this.token){
            throw {err:"Missing token"}
        }

        const opts = {
            endpoint:  this.socketAddress + "/websocket",
            SocketConstructor: ws,
            reconnectInterval: 5000
        };


        this.ddpConnection = new SimpleDDP(opts,[simpleDDPLogin])
        this.ddpConnection.on("connected",async (info)=>{
            console.log("Connected to " +  this.socketAddress);
            this.remoteUpSince = new Date((await this.ping()).upSince)
            try{
                await this.ddpConnection.login({userToken:this.hashUserToken()})
                await this.getConnectionService()
                await this.subscribeToQueue()
                await this.subscribeToData()
                this.schedulePing()
            }catch(err){
                console.error("ERR", err)
                this.ddpConnection.disconnect();
            }
        })


        this.ddpConnection.on('disconnected', () => {
            clearInterval(this.setIntervalId)
            for(const collectionHandler of this.collectionHandlers){
                collectionHandler.stop()
            }
            this.collectionHandlers = []
            if(this.queueSub){
                this.queueSub.remove()
                this.queueSub = null;
            }
            for(const collectionSubscription of this.collectionSubscription){
                collectionSubscription.remove()
            }
            this.collectionSubscription = []
            console.log("Disconnected from " +  this.socketAddress)

        });






    }

    tryToReconnect(){
        this.ddpConnection.disconnect();
        this.ddpConnection.connect()
    }


    async ping(){
        const protocol = (this.socketAddressURL.protocol === "wss:" || this.socketAddressURL.protocol === "https:")?"https:":"http:"
        const pingURL = protocol  +"//" + this.socketAddressURL.host + "/status"

        const res = await axios.get(pingURL,{timeout:this.timeout*1000})
        return res.data
    }

    async schedulePing(){

        this.setIntervalId = setInterval(async ()=>{

            console.log("ping")
            try{

                const data = await this.ping()

                if(data?.value!=="up"){
                    console.log("Ping failed")
                    this.tryToReconnect()
                }else{

                    const connectionTime = this.remoteUpSince.getTime()
                    const currentTime = new Date(data.upSince).getTime()
                    if(currentTime > connectionTime){
                        console.log("Ping failed")
                        this.tryToReconnect()
                    }
                }
            }catch(err){
                console.log("Ping failed")
                this.tryToReconnect()
            }
        },this.pingInterval*1000)


    }

    observeCollection(collectionName, onChange){
        const collection = this.ddpConnection.collection(collectionName)
        const collectionHandler = collection.onChange((obj)=>{
            if(typeof onChange == "function"){
                onChange( collectionName, obj)
            }
        })
        this.collectionHandlers.push(collectionHandler)
    }

    observeQueue(){

        this.observeCollection("queue",async (collectionName, obj)=> {
            const actions = []
            if (obj.added) {
                actions.push("added")
                if(obj.added.state === "added"){
                    this.emit("actionAdded",
                        obj.added,
                        (result, error)=>{
                            this.actionCallback(obj.added, result, error)
                        }
                    )
                }

            }
            if(obj.changed) {
                actions.push("changed")

            }
            if(obj.removed) {
                actions.push("removed")
            }
            this.emit("queueChange",
                obj,
                actions
            )
        })
    }


    async subscribeToData(){
        const collectionNames = await this.ddpConnection.call("getUserDataCollectionNames")
        for(const collectionName of collectionNames){

            this.observeCollection(collectionName,(collectionName, obj)=>{
                this.emit("dataChange",collectionName, {
                    changed:this.fixIdFromObject(obj.changed),
                    added:this.fixIdFromObject(obj.added),
                    removed:this.fixIdFromObject(obj.removed)
                })
            })
            await this.subscribeToCollection(collectionName)
        }

    }
    async subscribeToCollection(collectionName){
        const fields = this.connectionProps?.dataFields || this.connectionProps?.fields

        const sub = this.ddpConnection.subscribe("subscribeToServiceData",collectionName, {fields})
        await sub.ready()
        this.collectionSubscription.push(sub)
    }

    async subscribeToQueue(){
        this.observeQueue()
        this.queueSub = this.ddpConnection.subscribe("externalServiceQueue")
        await this.queueSub.ready()
    }


    actionCallback(obj, result, error){

        this.ddpConnection.call("actionCallback",obj.id, result, error)



    }

    async getConnectionService(){
        const connectionService = await this.ddpConnection.call("getConnectionService", this.serviceDescription)
        if(connectionService.serviceFound === true){
            this.emit("subscribedToService",connectionService)
        }
    }

    hashUserToken(){
        const hash = crypto.createHash('sha256');
        hash.update(this.token);
        return {
            digest: hash.digest('base64'),
            algorithm: "sha-256"
        }
    }


    /**
    * Attach an event handler function for the connection
    *
    * possible events are:<br>
    * <ul>
    *   <li>connected</li>
    *   <li>disconnected</li>
    *   <li>queueChange</li>
     *   <li>actionAdded</li>
     *   <li>dataChange</li>
     *   <li>subscribedToService</li>
    * </ul>
    *@param {string} event - Name of the event
    * @param {function} callback - Callback for the event
    **/
    on(event, callback){
        if(event === "disconnected" || event ==="connected"){
            return this.ddpConnection.on(event,callback)
        }
        return super.on(event, callback)
    }

    /**
     * Attach an event handler function to process the queue updates for the service actions
     * @param {queueCallback} callback - Callback which receives new data from the subscription
     *
     */
    onQueueChange(callback){
        return this.on("queueChange",callback)
    }

    /**
     * @callback queueCallback
     * @param {object} queueEntry object describing the action
     */


    /**
     *
     * Notify the external app when actions are added to the queue, the reply is given through a callback
     *
     *
     * @param {actionAddedCallback} callback Callback that handles actionAdded
     */
    onActionAdded(callback){
       return this.on("actionAdded",callback)
    }

    /**
     * @callback actionAddedCallback
     * @param {object} action object describing the action
     * @param {function} callback used to reply to the action
     */


    /**

     * @param {dataChangeCallback} callback Callback to process data change
     */
    onDataChange(callback){
        return this.on("dataChange",callback)
    }

    /**
     * @callback dataChangeCallback
     * @param {string} collectionName Name of the collection
     * @param {function} obj object representing the data added
     */


    /**
     *
     * @param {subscribedToServiceCallback}
     */
    onSubscribedToService(callback){
        return this.on("subscribedToService",callback)
    }

    /**
     * @callback subscribedToServiceCallback
     * @param {object} serviceInfo Description of the service and its properties
     */


    /**
     * Attach an event handler function when a connection is established
     * @param {function} callback - Callback which receives new data from the subscription
     *
     */
    onConnected(callback){
        return this.on("connected",callback)
    }

    /**
     * Attach an event handler function when a connection is finished
     * @param {function} callback - Callback which receives new data from the subscription
     *
     */
    onDisconnected(callback){
        return this.on("disconnected",callback)
    }

    /**
     * Call a function from meteor.
     *
     */
    call(){
        return this.ddpConnection.call(...arguments)
    }

    fixIdFromObject(obj){

        if(typeof obj == "object" && obj.id.length === 25 && obj.id.startsWith("-") && /[0-9A-Fa-f]{24}/g.test(obj.id)){
            const id = obj.id.substring(1,obj.id.length)
            return {...obj,id}
        }


        return obj
    }



}

exports.Connection = Connection

