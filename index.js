
const EventEmmiter = require("events")
const ws = require("ws");
const SimpleDDP = require("simpleddp");
const crypto = require("crypto");
const log4js = require("log4js");
const logger = log4js.getLogger();
logger.level = "debug";
const simpleDDPLogin = require("simpleddp-plugin-login").simpleDDPLogin;

/**
 * Establishes a connection with IoT Catalogue, allows a real time subscription with IoT Catalogue and to the dataset authenticated for the user
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
        this.waitForServerInterval = 10
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
            logger.info("Connected to " +  this.socketAddress);
            try{
                await this.waitForServer()
                await this.ddpConnection.login({userToken:this.hashUserToken()})
                await this.registerExternalServiceConnection()
                await this.subscribeToData()
                this.schedulePing()
            }catch(error){
                logger.error(error)
                this.ddpConnection.disconnect();
            }
        })

        this.ddpConnection.on('error', (error) => {
            logger.error(error)
        });

        this.ddpConnection.on('disconnected', () => {
            clearInterval(this.setIntervalId)
            for(const collectionHandler of this.collectionHandlers){
                collectionHandler.stop()
            }
            this.collectionHandlers = []
            if(this.actionSub){
                this.actionSub.remove()
                this.actionSub = null;
            }

            if(this.activeConnectionSub ){
                this.activeConnectionSub.remove();
                this.activeConnectionSub = null;
            }

            for(const collectionSubscription of this.collectionSubscription){
                collectionSubscription.remove()
            }
            this.collectionSubscription = []
            logger.info("Disconnected from " +  this.socketAddress)

        });






    }
    async waitForServer(){
        const {isServerReady} = await this.ddpConnection.call("getServerState")
        if(!isServerReady){
            logger.info("Server not ready, waiting " + this.waitForServerInterval + "s")
            await new Promise(resolve=>setTimeout(resolve,this.waitForServerInterval*1000))
            return this.waitForServer()
        }else{
            logger.info("Server ready")
        }
    }



    tryToReconnect(){
        logger.info("Reconnecting")
        this.ddpConnection.disconnect();
        this.ddpConnection.connect()
    }



    async schedulePing(){

        this.setIntervalId = setInterval(async ()=>{
            try{
                const error = new Promise((resolve, reject) => {
                    setTimeout(reject, this.timeout*1000, {reason:'ping timeout', timeout:true});
                });
                const res = await  Promise.race([this.ddpConnection.call("externalServicePing"), error])
                if(!res?.connectionEstablished){
                    logger.error("Ping failed: connection not established with IoT Catalogue")
                    this.tryToReconnect()
                }

            }catch(err){
                logger.error("Ping failed",err)

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

    observeActions(){
        const onChange = async (collectionName, obj)=>{

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



        }
        this.observeCollection("externalServiceCommunication",onChange)
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

    async subscribeToExternalServiceCommunication(){
        this.observeActions()
        this.actionSub = this.ddpConnection.subscribe("subscribeToExternalServiceCommunication")


        await this.actionSub.ready()
    }

    async registerExternalServiceConnection(){
        this.observeCollection("externalServiceActiveConnections",(collectionName, obj)=>{
            const res = this.checkNewConnectionState(obj,"serviceAssigned")

            if(res){
                this.emit("subscribedToService",res.externalService)
                this.subscribeToExternalServiceCommunication()
            }

        })
        this.activeConnectionSub = this.ddpConnection.subscribe("registerExternalServiceConnection",this.serviceDescription)
        await this.activeConnectionSub.ready()

    }

    checkNewConnectionState(obj, state){
        if(obj.changed?.prev?.state !== obj.changed?.next?.state  && obj.changed?.next?.state === state){
            return obj.changed.next
        }

        if(obj.added?.state === state){
            return obj.added
        }
    }

    actionCallback(obj, result, error){

        this.ddpConnection.call("actionCallback",obj.id, result, error)



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
     *
     * Notify the external app when actions are added, the reply is given through a callback
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

